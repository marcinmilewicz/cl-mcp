import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getLibraryConfig } from "../config.js";
import { getLibraryNames, withLibrary } from "../data/registry.js";
import { formatQuickContextForLLM, getQuickContext } from "../domain/context.js";

export function registerResourceHandlers(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getLibraryNames().flatMap((library) =>
      withLibrary(library, () => {
        const config = getLibraryConfig();
        const uriBase = `cl-mcp://${library}`;
        return [
          {
            uri: `${uriBase}/quick-reference`,
            name: `${library} Quick Reference`,
            description: `Selector map and critical rules for using ${config.packageName}`,
            mimeType: "text/plain",
          },
          {
            uri: `${uriBase}/selectors`,
            name: `${library} Selector Map (JSON)`,
            description: `JSON mapping of ${config.packageName} selectors to their main inputs/outputs`,
            mimeType: "application/json",
          },
        ];
      }),
    );
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    for (const library of getLibraryNames()) {
      const uriBase = `cl-mcp://${library}`;
      if (uri === `${uriBase}/quick-reference`) {
        return {
          contents: [{ uri, mimeType: "text/plain", text: withLibrary(library, () => formatQuickContextForLLM()) }],
        };
      }
      if (uri === `${uriBase}/selectors`) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: withLibrary(library, () => JSON.stringify(getQuickContext().selectorMap, null, 2)),
            },
          ],
        };
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  });
}
