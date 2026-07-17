/**
 * MCP Tool Request Router
 *
 * Pure protocol adapter: maps incoming MCP `tools/call` requests onto the
 * transport-agnostic tool handlers in `@cl-mcp/core`. All resolution and
 * formatting logic lives there.
 */

import { TOOL_HANDLERS } from "@cl-mcp/core";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function registerToolHandlers(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = TOOL_HANDLERS[name];

    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // biome-ignore lint/suspicious/noExplicitAny: SDK result type is looser than ToolResponse
    return handler((args ?? {}) as Record<string, unknown>) as any;
  });
}
