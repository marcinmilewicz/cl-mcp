#!/usr/bin/env node
/**
 * @cl-mcp/mcp-server
 *
 * Universal MCP server for component library metadata.
 * Loads pre-generated component-metadata.json and serves tools/resources to LLMs.
 *
 * Usage:
 *   CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json cl-mcp-server
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_SERVER_VERSION } from "./config.js";
import { loadPreloadedMetadata } from "./data/metadata.js";
import { getActiveLibrary, getLibraryNames, withLibrary } from "./data/registry.js";
import { registerResourceHandlers } from "./protocol/resources.js";
import { registerToolHandlers } from "./protocol/router.js";
import { registerToolDefinitions } from "./protocol/tools.js";

// Create MCP server
const server = new Server(
  { name: "cl-mcp-component-library-expert", version: MCP_SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

// Register handlers
registerResourceHandlers(server);
registerToolDefinitions(server);
registerToolHandlers(server);

// Start server
async function main(): Promise<void> {
  console.error(`cl-mcp Component Library MCP Server v${MCP_SERVER_VERSION}`);

  // Load metadata BEFORE accepting connections - fail fast on error
  try {
    loadPreloadedMetadata();
  } catch (error) {
    console.error("FATAL: Failed to load component metadata:", error);
    process.exit(1);
  }

  for (const name of getLibraryNames()) {
    withLibrary(name, () => {
      const lib = getActiveLibrary();
      const prefix = lib.config.selectorPrefix ? `, prefix: ${lib.config.selectorPrefix}` : "";
      console.error(
        `Library '${name}': ${lib.config.packageName} (${lib.config.framework ?? "angular"}${prefix}) from ${lib.metadataPath}`,
      );
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
