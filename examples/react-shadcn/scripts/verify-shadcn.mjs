#!/usr/bin/env node

/**
 * shadcn-style pipeline verification. The fixture mirrors what the shadcn
 * CLI copies into a real repo (components/ui/*.tsx) — the point is to pin
 * the patterns that matter there:
 *   - `const Button = forwardRef(...); export { Button }` detection
 *   - cva `VariantProps<typeof buttonVariants>` → literal-union values
 *   - Radix `ComponentPropsWithoutRef<typeof Primitive.X>` props
 *   - DOM props (React.ButtonHTMLAttributes) filtered out
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
const METADATA_PATH = resolve(EXAMPLE_ROOT, 'data/shadcn/component-metadata.json');

const TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ── Step 1: metadata assertions ─────────────────────────────────────

console.log('Checking metadata quality...');
const metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf-8'));
const names = Object.keys(metadata.components);

for (const expected of ['Button', 'Input', 'DialogContent', 'DialogTitle']) {
  assert(names.includes(expected), `expected component ${expected} to be detected (got: ${names.join(', ')})`);
}

const button = metadata.components.Button.analysis[0].components[0];
const variant = button.inputs.find((i) => i.name === 'variant');
assert(
  JSON.stringify(variant?.resolvedValues?.values) ===
    JSON.stringify(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']),
  `cva variant values should resolve through VariantProps<typeof buttonVariants>, got ${JSON.stringify(variant?.resolvedValues)}`,
);
const size = button.inputs.find((i) => i.name === 'size');
assert(size?.resolvedValues?.values?.includes('icon'), 'cva size values should resolve');

// DOM props inherited from React.ButtonHTMLAttributes must be filtered.
const buttonPropNames = button.inputs.map((i) => i.name);
assert(!buttonPropNames.includes('className'), 'className (DOM prop) should be filtered out');
assert(buttonPropNames.includes('asChild'), 'asChild (own prop) should be kept');

// Radix-derived props on DialogContent come from @radix-ui typings (kept).
const dialogContent = metadata.components.DialogContent.analysis[0].components[0];
assert(dialogContent.inputs.length > 0, 'DialogContent should surface Radix-derived props');

console.log(`  Components: ${names.join(', ')}`);
console.log(`  Button variant values: ${variant.resolvedValues.values.join(', ')}`);

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
      clientInfo: { name: 'verify-shadcn', version: '1.0.0' },
    }));
    const init = await waitFor(1);
    if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
    send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

    const btn = await call('get_component', { componentName: 'Button' });
    const btnText = btn.content.map((c) => c.text).join('');
    assert(btnText.includes('destructive'), 'get_component Button should list cva variant values');

    const ok = await call('validate_usage', {
      code: '<Button variant="destructive" size="lg">Delete</Button>',
      componentNames: ['Button'],
    });
    assert(ok.content.map((c) => c.text).join('').includes('"valid": true'), 'valid Button usage should pass');

    const bad = await call('validate_usage', {
      code: '<Button varaint="destructive" />',
      componentNames: ['Button'],
    });
    assert(bad.isError === true, 'typo prop should be rejected');
    assert(bad.content.map((c) => c.text).join('').includes('variant'), 'rejection should suggest variant');

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

  const get = run(['get', 'Button']);
  assert(get.status === 0, `get exited ${get.status}: ${get.stderr}`);
  assert(get.stdout.includes('destructive'), 'CLI get Button should list cva variants');

  console.log('  CLI checks passed');
}

await verifyServer();
verifyCli();

console.log('\nshadcn-style pipeline verification passed!');
process.exit(0);
