#!/usr/bin/env node

/**
 * NG-ZORRO pipeline verification — the second real-world Angular library.
 * Pins quality floors (conservative, tag bumps shouldn't break them) and
 * exercises the MCP server over the generated metadata.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(EXAMPLE_ROOT, '..', '..');
const SERVER_PATH = resolve(REPO_ROOT, 'packages/mcp-server/dist/index.js');
const METADATA_PATH = resolve(EXAMPLE_ROOT, 'data/ng-zorro/component-metadata.json');

const MIN_COMPONENTS = 60;
const MIN_SELECTORS = 500;
const TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ── Step 1: metadata quality floors ─────────────────────────────────

console.log('Checking metadata quality...');
const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf-8'));
assert((metadata.framework ?? 'angular') === 'angular', 'framework should be angular');

const names = Object.keys(metadata.components);
assert(names.length >= MIN_COMPONENTS, `expected >= ${MIN_COMPONENTS} components, got ${names.length}`);
const selectorCount = Object.keys(metadata.selectorMap ?? {}).length;
assert(selectorCount >= MIN_SELECTORS, `expected >= ${MIN_SELECTORS} selectors, got ${selectorCount}`);

const errors = (metadata.diagnostics ?? []).filter((d) => d.severity === 'error');
assert(errors.length === 0, `expected zero error-severity diagnostics, got ${errors.length}`);

// Representative extraction check: NzButtonComponent's nzType literal union
// resolves THROUGH the NzButtonType alias (TypeChecker path).
const button = metadata.components.button;
assert(button?.kind === 'analyzed', 'button component should be analyzed');
const buttonComponent = button.analysis.flatMap((a) => a.components).find((c) => c.className === 'NzButtonComponent');
assert(buttonComponent, 'NzButtonComponent should be extracted');
const nzType = buttonComponent.inputs.find((i) => i.name === 'nzType');
assert(
  nzType?.resolvedValues?.values?.includes('primary'),
  `nzType literal union should resolve through the NzButtonType alias, got ${JSON.stringify(nzType?.resolvedValues)}`,
);

console.log(`  Components: ${names.length}, selectors: ${selectorCount}`);
console.log(`  Diagnostics: 0 errors, ${(metadata.diagnostics ?? []).length} warnings`);

// ── Step 2: MCP server ──────────────────────────────────────────────

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
      clientInfo: { name: 'verify-ngzorro', version: '1.0.0' },
    }));
    const init = await waitFor(1);
    if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
    send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    const btn = await call('get_component', { componentName: 'button' });
    const btnText = btn.content.map((c) => c.text).join('');
    assert(btnText.includes('nz-button'), 'get_component button should reference the nz-button selector');
    assert(btnText.includes('nzType') || btnText.includes('NzButton'), 'get_component button should list the API');

    const search = await call('find_components', { query: 'notification popup' });
    const searchText = search.content.map((c) => c.text).join('');
    assert(searchText.length > 100, 'semantic search should return results');

    const ok = await call('validate_template', {
      template: '<nz-alert nzType="success" nzMessage="ok"></nz-alert>',
      componentNames: ['alert'],
    });
    assert(ok.content.map((c) => c.text).join('').includes('"valid": true'), 'valid nz-alert template should pass');

    const bad = await call('validate_template', {
      template: '<nz-alert nzTyppe="success"></nz-alert>',
      componentNames: ['alert'],
    });
    assert(bad.isError === true, 'typo input on nz-alert should be rejected');

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

await verifyServer();

console.log('\nNG-ZORRO pipeline verification passed!');
process.exit(0);
