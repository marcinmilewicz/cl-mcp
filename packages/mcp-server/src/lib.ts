/**
 * Programmatic entry point (`@cl-mcp/mcp-server/lib`).
 *
 * Exposes the server's data + domain layers WITHOUT the stdio transport so
 * other frontends (the `@cl-mcp/cli` package) can drive the exact same tool
 * handlers the MCP server uses. Importing this module has no side effects —
 * unlike the package root, which boots the stdio server.
 */

export { getLibraryConfig, type LibraryConfig, MCP_SERVER_VERSION } from "./config.js";
export { loadPreloadedMetadata } from "./data/metadata.js";
export {
  getActiveLibrary,
  getLibraryNames,
  isMultiLibrary,
  resolveLibraryQualifier,
  setActiveLibrary,
  withLibrary,
  type LoadedLibrary,
} from "./data/registry.js";
export { TOOL_HANDLERS, type ToolResponse } from "./protocol/router.js";
