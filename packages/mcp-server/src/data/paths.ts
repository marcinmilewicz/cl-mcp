/**
 * Path resolution for @cl-mcp/mcp-server.
 *
 * Resolves the metadata JSON file path using:
 * 1. CL_MCP_METADATA_PATH environment variable (direct path to JSON)
 * 2. CL_MCP_DATA_DIR environment variable + library name
 * 3. Default data/ directory relative to package root
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METADATA_FILENAME } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Validate that a path doesn't contain traversal sequences. */
function validateSecurePath(envVar: string, value: string): string {
  if (value.includes('..')) {
    throw new Error(`[MCP] Security: ${envVar} contains path traversal sequence: "${value}"`);
  }
  return path.resolve(value);
}

/** Walk up from startDir looking for a directory containing marker. */
function findAncestorWithFile(startDir: string, filename: string, maxDepth = 8): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    if (fs.existsSync(path.join(dir, filename))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every metadata file found in a data directory (all subdirs + the dir itself). */
function scanDataDir(dataDir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) return found;

  const entries = fs.readdirSync(dataDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dataDir, entry.name, METADATA_FILENAME);
    if (fs.existsSync(candidate)) found.push(candidate);
  }
  const direct = path.join(dataDir, METADATA_FILENAME);
  if (fs.existsSync(direct)) found.push(direct);
  return found;
}

/**
 * Resolve EVERY loadable component-metadata.json. A single result is the
 * single-library mode; multiple results put the server into multi-library
 * mode (one registry entry per file).
 */
export function resolveAllMetadataPaths(): string[] {
  // 1. Direct path via environment variable — always single-library.
  if (process.env.CL_MCP_METADATA_PATH) {
    const metadataPath = validateSecurePath('CL_MCP_METADATA_PATH', process.env.CL_MCP_METADATA_PATH);
    if (fs.existsSync(metadataPath) && fs.statSync(metadataPath).isFile()) {
      return [metadataPath];
    }
    // If path is a directory, look for metadata file inside
    const inDir = path.join(metadataPath, METADATA_FILENAME);
    if (fs.existsSync(inDir)) {
      return [inDir];
    }
    throw new Error(`[MCP] Metadata not found at CL_MCP_METADATA_PATH: ${metadataPath}`);
  }

  // 2. Data directory via environment variable — every library inside.
  if (process.env.CL_MCP_DATA_DIR) {
    const dataDir = validateSecurePath('CL_MCP_DATA_DIR', process.env.CL_MCP_DATA_DIR);
    const found = scanDataDir(dataDir);
    if (found.length > 0) return found;
  }

  // 3. Look for data/ directory relative to workspace root
  const workspaceRoot = findAncestorWithFile(__dirname, 'package.json');
  if (workspaceRoot) {
    // Try monorepo root (go up from packages/mcp-server/dist/data/)
    const monorepoRoot = findAncestorWithFile(workspaceRoot, 'vitest.workspace.ts');
    if (monorepoRoot) {
      const found = scanDataDir(path.join(monorepoRoot, 'data'));
      if (found.length > 0) return found;
    }
  }

  throw new Error(
    `[MCP] Component metadata not found. Set CL_MCP_METADATA_PATH to the path of your ${METADATA_FILENAME} file, ` +
    `or CL_MCP_DATA_DIR to a directory of per-library metadata.\n` +
    `  Example: CL_MCP_METADATA_PATH=./data/angular-material/${METADATA_FILENAME}`
  );
}

/** First resolvable metadata path — legacy single-library entry point. */
export function resolveMetadataPath(): string {
  return resolveAllMetadataPaths()[0];
}
