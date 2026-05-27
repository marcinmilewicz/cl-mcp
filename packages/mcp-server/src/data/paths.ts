/**
 * Path resolution for @cl-mcp/mcp-server.
 *
 * Resolves the metadata JSON file path using:
 * 1. CL_MCP_METADATA_PATH environment variable (direct path to JSON)
 * 2. CL_MCP_DATA_DIR environment variable + library name
 */

import fs from 'node:fs';
import path from 'node:path';
import { METADATA_FILENAME } from '../config.js';

/** Validate that a path doesn't contain traversal sequences. */
function validateSecurePath(envVar: string, value: string): string {
  if (value.includes('..')) {
    throw new Error(`[MCP] Security: ${envVar} contains path traversal sequence: "${value}"`);
  }
  return path.resolve(value);
}

export function resolveMetadataPath(): string {
  // 1. Direct path via environment variable
  if (process.env.CL_MCP_METADATA_PATH) {
    const metadataPath = validateSecurePath('CL_MCP_METADATA_PATH', process.env.CL_MCP_METADATA_PATH);
    if (fs.existsSync(metadataPath)) {
      return metadataPath;
    }
    // If path is a directory, look for metadata file inside
    const inDir = path.join(metadataPath, METADATA_FILENAME);
    if (fs.existsSync(inDir)) {
      return inDir;
    }
    throw new Error(`[MCP] Metadata not found at CL_MCP_METADATA_PATH: ${metadataPath}`);
  }

  // 2. Data directory via environment variable
  if (process.env.CL_MCP_DATA_DIR) {
    const dataDir = validateSecurePath('CL_MCP_DATA_DIR', process.env.CL_MCP_DATA_DIR);
    // Look for any metadata JSON in the data directory
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(dataDir, entry.name, METADATA_FILENAME);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      // Also check directly in the data dir
      const direct = path.join(dataDir, METADATA_FILENAME);
      if (fs.existsSync(direct)) {
        return direct;
      }
    }
  }

  throw new Error(
    `[MCP] Component metadata not found. Set CL_MCP_METADATA_PATH to the path of your ${METADATA_FILENAME} file.\n` +
    `  Example: CL_MCP_METADATA_PATH=./examples/angular-material/data/${METADATA_FILENAME}`
  );
}

let _resolvedPath: string | undefined;

/**
 * Lazily resolve (and memoize) the metadata path. Resolution is deferred to the
 * first call so that merely importing this module — e.g. to use an unrelated
 * pure helper — never touches the filesystem or throws on a missing
 * CL_MCP_METADATA_PATH. The server triggers resolution at startup via
 * loadPreloadedMetadata(), so fail-fast on misconfiguration is preserved.
 */
export function getMetadataPath(): string {
  if (_resolvedPath === undefined) {
    _resolvedPath = resolveMetadataPath();
  }
  return _resolvedPath;
}
