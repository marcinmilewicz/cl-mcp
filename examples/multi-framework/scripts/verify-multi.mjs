#!/usr/bin/env node

/**
 * Multi-framework pipeline smoke test.
 *
 * 1. Asserts the workspace generation produced per-library metadata + manifest.
 * 2. Spawns the MCP server in multi-library mode (CL_MCP_DATA_DIR) and
 *    verifies cross-library resolution + framework-dispatched validation.
 * 3. Runs the cl-mcp CLI bin and asserts output + exit codes.
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(EXAMPLE_ROOT, '..', '..');
const SERVER_PATH = resolve(REPO_ROOT, 'packages/mcp-server/dist/index.js');
const CLI_PATH = resolve(REPO_ROOT, 'packages/cli/dist/index.js');
const DATA_DIR = resolve(EXAMPLE_ROOT, 'data');

const EXPECTED_TOOL_COUNT = 6;
const TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ── Step 1: generated artifacts ─────────────────────────────────────

console.log('Checking generated artifacts...');
assert(existsSync(resolve(DATA_DIR, 'workspace-manifest.json')), 'workspace-manifest.json missing — run `npm run analyze` first');
assert(existsSync(resolve(DATA_DIR, 'ui/component-metadata.json')), 'ui metadata missing');
assert(existsSync(resolve(DATA_DIR, 'forms/component-metadata.json')), 'forms metadata missing');

const manifest = JSON.parse(readFileSync(resolve(DATA_DIR, 'workspace-manifest.json'), 'utf-8'));
const libNames = manifest.libraries.map((l) => l.name).sort();
assert(JSON.stringify(libNames) === JSON.stringify(['forms', 'ui']), `unexpected libraries: ${libNames}`);
const uiEntry = manifest.libraries.find((l) => l.name === 'ui');
assert(uiEntry.framework === 'react', 'ui should be detected as react');
assert(uiEntry.importAlias === '@acme/ui', 'ui alias should come from tsconfig paths');
console.log(`  Manifest OK: ${manifest.libraries.map((l) => `${l.name} (${l.framework})`).join(', ')}`);

// ── Step 2: MCP server in multi-library mode ────────────────────────

let requestId = 0;
const jsonRpcRequest = (method, params = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params });
const jsonRpcNotification = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', method, params });

async function verifyServer() {
  console.log('Starting MCP server (multi-library)...');
  const server = spawn('node', [SERVER_PATH], {
    env: { ...process.env, CL_MCP_DATA_DIR: DATA_DIR, CL_MCP_METADATA_PATH: '' },
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
      clientInfo: { name: 'verify-multi', version: '1.0.0' },
    }));
    const init = await waitFor(1);
    if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
    send(jsonRpcNotification('notifications/initialized'));

    send(jsonRpcRequest('tools/list', {}));
    const toolsResp = await waitFor(2);
    const tools = toolsResp.result.tools.map((t) => t.name);
    assert(tools.length === EXPECTED_TOOL_COUNT, `expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
    assert(tools.includes('validate_usage'), 'validate_usage tool missing');
    console.log(`  Tools (${tools.length}): ${tools.join(', ')}`);

    const overview = await call('get_library_overview', {});
    const overviewText = overview.content.map((c) => c.text).join('');
    assert(overviewText.includes('# Library: ui') && overviewText.includes('# Library: forms'),
      'overview should render one section per library');

    const button = await call('get_component', { componentName: 'ui:Button' });
    const buttonText = button.content.map((c) => c.text).join('');
    assert(buttonText.includes('variant={value}'), 'React component should render JSX-style examples');

    const input = await call('get_component', { componentName: 'input' });
    const inputText = input.content.map((c) => c.text).join('');
    assert(inputText.includes('org-input'), 'Angular component should resolve unqualified across libraries');

    const validOk = await call('validate_usage', {
      code: '<Button disabled={true} variant="danger" />',
      componentNames: ['Button'],
    });
    assert(validOk.content.map((c) => c.text).join('').includes('"valid": true'), 'valid JSX should pass');

    const validBad = await call('validate_usage', {
      code: '<Button disabled={true} varint="danger" />',
      componentNames: ['Button'],
    });
    assert(validBad.isError === true, 'hallucinated prop should be rejected');
    assert(validBad.content.map((c) => c.text).join('').includes('variant'), 'rejection should suggest the right prop');

    console.log('  MCP server multi-library checks passed');
    server.kill();
    clearTimeout(timeout);
  } catch (err) {
    console.error(stderr);
    server.kill();
    clearTimeout(timeout);
    throw err;
  }
}

// ── Step 3: CLI bin ─────────────────────────────────────────────────

function verifyCli() {
  console.log('Verifying cl-mcp CLI...');
  const env = { ...process.env, CL_MCP_METADATA_PATH: '', CL_MCP_DATA_DIR: '' };
  const run = (args) => spawnSync('node', [CLI_PATH, ...args, '--data-dir', DATA_DIR], { env, encoding: 'utf-8' });

  const list = run(['list-libraries']);
  assert(list.status === 0, `list-libraries exited ${list.status}: ${list.stderr}`);
  assert(list.stdout.includes('| ui |') && list.stdout.includes('| forms |'), 'list-libraries should show both libraries');

  const get = run(['get', 'ui:Button']);
  assert(get.status === 0, `get exited ${get.status}: ${get.stderr}`);
  assert(get.stdout.includes('variant={value}'), 'CLI get should render the same JSX examples as MCP');

  const ok = run(['validate', '--code', '<Button disabled={true} />', '--components', 'Button']);
  assert(ok.status === 0, `valid snippet should exit 0, got ${ok.status}: ${ok.stderr}`);

  const bad = run(['validate', '--code', '<Button disabled={true} varint="x" />', '--components', 'Button']);
  assert(bad.status === 1, `invalid snippet should exit 1, got ${bad.status}`);

  console.log('  CLI checks passed');
}

await verifyServer();
verifyCli();

console.log('\nMulti-framework pipeline verification passed!');
process.exit(0);
