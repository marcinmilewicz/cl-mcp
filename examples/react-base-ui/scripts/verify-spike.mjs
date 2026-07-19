#!/usr/bin/env node

/**
 * Spike verification: the React analyzer ran against a REAL library
 * (MUI's Base UI). Asserts detection coverage and prop quality thresholds,
 * then exercises the MCP server and the cl-mcp CLI over the metadata.
 *
 * Thresholds are deliberately conservative (Base UI is a moving target on
 * `master`) — they pin the floor, not today's exact numbers.
 */

import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(EXAMPLE_ROOT, '..', '..');
const SERVER_PATH = resolve(REPO_ROOT, 'packages/mcp-server/dist/index.js');
const CLI_PATH = resolve(REPO_ROOT, 'packages/cli/dist/index.js');
const METADATA_PATH = resolve(EXAMPLE_ROOT, 'data/base-ui/component-metadata.json');

const MIN_COMPONENTS = 150;
const MIN_PROP_RESOLUTION_RATIO = 0.9;
const TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ── Step 1: metadata quality thresholds ─────────────────────────────

console.log('Checking metadata quality...');
const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf-8'));
assert(metadata.framework === 'react', 'framework should be react');

const names = Object.keys(metadata.components);
assert(
  names.length >= MIN_COMPONENTS,
  `expected at least ${MIN_COMPONENTS} detected components, got ${names.length}`,
);

let resolvedTypes = 0;
let unresolvedTypes = 0;
let withProps = 0;
let totalCallbacks = 0;
for (const name of names) {
  const component = metadata.components[name].analysis[0].components[0];
  if (component.inputs.length > 0) withProps++;
  totalCallbacks += component.outputs.length;
  for (const input of component.inputs) {
    if (input.typeResolved) resolvedTypes++;
    else unresolvedTypes++;
  }
}
const ratio = resolvedTypes / Math.max(resolvedTypes + unresolvedTypes, 1);
assert(
  ratio >= MIN_PROP_RESOLUTION_RATIO,
  `prop type resolution ratio ${ratio.toFixed(2)} below ${MIN_PROP_RESOLUTION_RATIO} — is @types/react installed? (run npm run setup)`,
);
assert(totalCallbacks > 20, `expected plenty of detected callbacks, got ${totalCallbacks}`);

// Hard-pattern representatives (compound public names): helper-rendered
// (no JSX literal), custom factory wrapper, and forwardRef respectively.
for (const expected of ['Dialog.Root', 'Tooltip.Root', 'Checkbox.Root']) {
  assert(names.includes(expected), `expected component ${expected} to be detected`);
}
const compoundCount = names.filter((n) => n.includes('.')).length;
assert(compoundCount >= 100, `expected most components to carry compound names, got ${compoundCount}`);

const dialogRoot = metadata.components['Dialog.Root'].analysis[0].components[0];
assert(dialogRoot.className === 'DialogRoot', 'className should stay the internal declaration name');
assert(dialogRoot.metadata.selector === 'Dialog.Root', 'selector should be the compound public name');
assert(
  dialogRoot.outputs.some((o) => o.name === 'onOpenChange'),
  'Dialog.Root should expose the onOpenChange callback',
);

console.log(`  Components: ${names.length} (${withProps} with props, ${compoundCount} compound-named)`);
console.log(`  Prop types resolved: ${resolvedTypes}/${resolvedTypes + unresolvedTypes} (${(ratio * 100).toFixed(0)}%)`);
console.log(`  Callback props: ${totalCallbacks}`);

// ── Step 2: MCP server over the metadata ────────────────────────────

let requestId = 0;
const jsonRpcRequest = (method, params = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params });

async function verifyServer() {
  console.log('Starting MCP server...');
  const server = spawn('node', [SERVER_PATH], {
    env: { ...process.env, CL_MCP_METADATA_PATH: METADATA_PATH, CL_MCP_DATA_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    console.error('ERROR: Server timed out');
    console.error(stderr);
    server.kill();
    process.exit(1);
  }, TIMEOUT_MS);

  const responses = new Map();
  let buffer = '';
  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) responses.set(msg.id, msg);
      } catch {
        // ignore
      }
    }
  });

  const send = (message) => server.stdin.write(`${message}\n`);
  const waitFor = (id) =>
    new Promise((res) => {
      const check = setInterval(() => {
        if (responses.has(id)) {
          clearInterval(check);
          res(responses.get(id));
        }
      }, 50);
    });

  const call = async (name, args) => {
    send(jsonRpcRequest('tools/call', { name, arguments: args }));
    const resp = await waitFor(requestId);
    if (resp.error) fail(`${name} failed: ${JSON.stringify(resp.error)}`);
    return resp.result;
  };

  try {
    send(jsonRpcRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-spike', version: '1.0.0' },
    }));
    const init = await waitFor(1);
    if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
    send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    // Both name forms must resolve: the compound public name AND the
    // internal declaration name (resolver strips separators including '.').
    const dialog = await call('get_component', { componentName: 'Dialog.Root' });
    const dialogText = dialog.content.map((c) => c.text).join('');
    assert(dialogText.includes('onOpenChange'), 'get_component Dialog.Root should list onOpenChange');
    assert(dialogText.includes('modal'), 'get_component Dialog.Root should list the modal prop');

    const dialogByInternal = await call('get_component', { componentName: 'DialogRoot' });
    assert(
      dialogByInternal.content.map((c) => c.text).join('').includes('onOpenChange'),
      'internal name DialogRoot should resolve to Dialog.Root',
    );

    // Compound JSX usage validates; internal-name JSX + internal component
    // name keep working too.
    const ok = await call('validate_usage', {
      code: '<Dialog.Root defaultOpen={true} modal="trap-focus" />',
      componentNames: ['Dialog.Root'],
    });
    assert(ok.content.map((c) => c.text).join('').includes('"valid": true'), 'valid Dialog.Root usage should pass');

    const okInternal = await call('validate_usage', {
      code: '<DialogRoot defaultOpen={true} modal={true} />',
      componentNames: ['DialogRoot'],
    });
    assert(
      okInternal.content.map((c) => c.text).join('').includes('"valid": true'),
      'internal-name JSX + component name should validate too',
    );

    const bad = await call('validate_usage', {
      code: '<Dialog.Root defaultOpne={true} />',
      componentNames: ['Dialog.Root'],
    });
    assert(bad.isError === true, 'typo prop should be rejected');
    assert(
      bad.content.map((c) => c.text).join('').includes('defaultOpen'),
      'rejection should suggest defaultOpen',
    );

    console.log('  MCP server checks passed');
    server.kill();
    clearTimeout(timeout);
  } catch (err) {
    console.error(stderr);
    server.kill();
    clearTimeout(timeout);
    throw err;
  }
}

// ── Step 3: CLI ─────────────────────────────────────────────────────

function verifyCli() {
  console.log('Verifying cl-mcp CLI...');
  const env = { ...process.env, CL_MCP_METADATA_PATH: '', CL_MCP_DATA_DIR: '' };
  const run = (args) => spawnSync('node', [CLI_PATH, ...args, '--metadata', METADATA_PATH], { env, encoding: 'utf-8' });

  const find = run(['find', 'dialog']);
  assert(find.status === 0, `find exited ${find.status}: ${find.stderr}`);
  assert(find.stdout.includes('Dialog'), 'find dialog should surface Dialog components');

  const get = run(['get', 'Tooltip.Root']);
  assert(get.status === 0, `get exited ${get.status}: ${get.stderr}`);
  assert(get.stdout.includes('onOpenChange'), 'CLI get Tooltip.Root should list callbacks');

  const getInternal = run(['get', 'TooltipRoot']);
  assert(getInternal.status === 0, `get by internal name exited ${getInternal.status}: ${getInternal.stderr}`);
  assert(getInternal.stdout.includes('onOpenChange'), 'CLI get TooltipRoot should resolve to Tooltip.Root');

  console.log('  CLI checks passed');
}

await verifyServer();
verifyCli();

console.log('\nBase UI spike verification passed!');
process.exit(0);
