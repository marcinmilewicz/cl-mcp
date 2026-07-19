#!/usr/bin/env node
/**
 * @cl-mcp/mcp-server
 *
 * MCP protocol (stdio) adapter over @cl-mcp/core. Loads pre-generated
 * component metadata (one or many libraries) and serves the core's tool
 * handlers plus quick-reference resources to LLM clients.
 *
 * Usage:
 *   CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json cl-mcp-server
 *   CL_MCP_DATA_DIR=./data cl-mcp-server
 */

import { getActiveLibrary, getLibraryNames, loadPreloadedMetadata, withLibrary } from "@cl-mcp/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerResourceHandlers } from "./protocol/resources.js";
import { registerToolHandlers } from "./protocol/router.js";
import { registerToolDefinitions } from "./protocol/tools.js";

export const MCP_SERVER_VERSION = "1.0.0";

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
