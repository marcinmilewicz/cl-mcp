#!/usr/bin/env node

/**
 * Smoke test for the MCP server pipeline.
 *
 * Spawns the MCP server, sends JSON-RPC 2.0 requests over stdin,
 * and verifies tools are registered and respond correctly.
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const EXAMPLE_ROOT = resolve(__dirname, '..');
const SERVER_PATH = resolve(ROOT, 'packages/mcp-server/dist/index.js');
const METADATA_PATH = resolve(EXAMPLE_ROOT, 'data/component-metadata.json');

const EXPECTED_TOOL_COUNT = 6;
const TIMEOUT_MS = 30_000;

let requestId = 0;

function jsonRpcRequest(method, params = {}) {
  requestId++;
  return JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
}

function jsonRpcNotification(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

async function main() {
  console.log('Starting MCP server...');

  const server = spawn('node', [SERVER_PATH], {
    env: { ...process.env, CL_MCP_METADATA_PATH: METADATA_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const timeout = setTimeout(() => {
    console.error('ERROR: Server timed out');
    server.kill();
    process.exit(1);
  }, TIMEOUT_MS);

  const responses = new Map();
  let buffer = '';

  function waitForResponse(id) {
    return new Promise((resolve) => {
      if (responses.has(id)) {
        resolve(responses.get(id));
        return;
      }
      const check = setInterval(() => {
        if (responses.has(id)) {
          clearInterval(check);
          resolve(responses.get(id));
        }
      }, 50);
    });
  }

  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();

    // MCP stdio transport is newline-delimited JSON
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          responses.set(msg.id, msg);
        }
      } catch {
        // ignore parse errors
      }
    }
  });

  function send(message) {
    server.stdin.write(`${message}\n`);
  }

  try {
    // Step 1: Initialize
    send(jsonRpcRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-script', version: '1.0.0' },
    }));
    const initResp = await waitForResponse(1);
    if (initResp.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(initResp.error)}`);
    }
    console.log(`  Server: ${initResp.result.serverInfo?.name ?? 'unknown'} v${initResp.result.serverInfo?.version ?? '?'}`);

    // Step 2: Initialized notification
    send(jsonRpcNotification('notifications/initialized'));

    // Step 3: List tools
    send(jsonRpcRequest('tools/list', {}));
    const toolsResp = await waitForResponse(2);
    if (toolsResp.error) {
      throw new Error(`tools/list failed: ${JSON.stringify(toolsResp.error)}`);
    }
    const tools = toolsResp.result.tools;
    const toolNames = tools.map((t) => t.name);
    console.log(`  Tools (${tools.length}): ${toolNames.join(', ')}`);

    if (tools.length !== EXPECTED_TOOL_COUNT) {
      throw new Error(`Expected ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`);
    }

    // Step 4: Call get_library_overview
    send(jsonRpcRequest('tools/call', {
      name: 'get_library_overview',
      arguments: {},
    }));
    const overviewResp = await waitForResponse(3);
    if (overviewResp.error) {
      throw new Error(`get_library_overview failed: ${JSON.stringify(overviewResp.error)}`);
    }

    const content = overviewResp.result.content;
    const text = content?.map((c) => c.text).join('') ?? '';
    if (!text || text.length < 100) {
      throw new Error('get_library_overview returned insufficient data');
    }

    // Extract component count from response
    const componentMatch = text.match(/(\d+)\s*component/i);
    const componentCount = componentMatch ? componentMatch[1] : 'unknown';

    console.log('');
    console.log('Pipeline verification passed!');
    console.log(`  Components found: ${componentCount}`);
    console.log(`  Tools available: ${tools.length}`);
    console.log(`  Overview length: ${text.length} chars`);

    server.kill();
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    if (stderr) {
      console.error(`Server stderr:\n${stderr}`);
    }
    server.kill();
    clearTimeout(timeout);
    process.exit(1);
  }
}

main();
