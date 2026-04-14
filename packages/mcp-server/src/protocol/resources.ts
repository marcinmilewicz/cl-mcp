import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getLibraryConfig } from "../config.js";
import { formatQuickContextForLLM, getQuickContext } from "../domain/context.js";

export function registerResourceHandlers(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const config = getLibraryConfig();
    const uriBase = `cl-mcp://${config.name}`;

    return {
      resources: [
        {
          uri: `${uriBase}/quick-reference`,
          name: "Component Library Quick Reference",
          description: `Selector map and critical rules for using ${config.packageName}`,
          mimeType: "text/plain",
        },
        {
          uri: `${uriBase}/selectors`,
          name: "Selector Map (JSON)",
          description: "JSON mapping of selectors to their main inputs/outputs",
          mimeType: "application/json",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const config = getLibraryConfig();
    const uriBase = `cl-mcp://${config.name}`;

    if (uri === `${uriBase}/quick-reference`) {
      return {
        contents: [{ uri, mimeType: "text/plain", text: formatQuickContextForLLM() }],
      };
    }

    if (uri === `${uriBase}/selectors`) {
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(getQuickContext().selectorMap, null, 2) }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });
}
