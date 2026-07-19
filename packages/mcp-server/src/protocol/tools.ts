import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shared `library` property — present on every tool. In single-library mode
 * it can be omitted entirely; in multi-library mode it scopes the tool (and
 * component names additionally accept a `lib:Name` qualifier).
 */
const LIBRARY_PROPERTY = {
  library: {
    type: "string",
    description:
      "Library to scope this call to (multi-library servers only; name or package alias). " +
      "Omit to search across all loaded libraries.",
  },
} as const;

export function registerToolDefinitions(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_library_overview",
          description:
            "Start here → find_components → get_component → validate_template/validate_usage. Returns a compact reference of all components with their selectors/JSX names, inputs map, critical rules, plus directive and pipe listings. Multi-library servers return one section per library unless `library` is given.",
          inputSchema: {
            type: "object",
            properties: {
              format: {
                type: "string",
                enum: ["text", "json"],
                description: "Output format (default: text)",
              },
              ...LIBRARY_PROPERTY,
            },
            required: [],
          },
        },
        {
          name: "find_components",
          description:
            "Search or browse components. Modes: (1) query — semantic search by name, keyword, selector, or intent (returns top 5). (2) list_all — compact listing without summaries. (3) no params — flat list with summaries.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: 'Natural language search (e.g., "date picker", "dropdown menu")',
              },
              list_all: {
                type: "boolean",
                description: "Return a compact listing without detailed summaries (default: false)",
              },
              ...LIBRARY_PROPERTY,
            },
            required: [],
          },
        },
        {
          name: "get_component",
          description:
            'Get detailed information about a single component. detail_level: "api" (default) = strict input/output reference, "full" = complete with inheritance/config, "examples" = usage patterns, "types" = TypeScript types. Component names accept a "lib:Name" qualifier on multi-library servers.',
          inputSchema: {
            type: "object",
            properties: {
              componentName: {
                type: "string",
                description: 'Component name, selector, or JSX name (optionally qualified: "ui:Button")',
              },
              detail_level: {
                type: "string",
                enum: ["api", "full", "examples", "types"],
                description: "Level of detail (default: api)",
              },
              ...LIBRARY_PROPERTY,
            },
            required: ["componentName"],
          },
        },
        {
          name: "get_components_batch",
          description: "Get detailed information about multiple components in a single call.",
          inputSchema: {
            type: "object",
            properties: {
              componentNames: {
                type: "array",
                items: { type: "string" },
                description: 'Array of component names (each optionally qualified: "ui:Button")',
              },
              detail_level: {
                type: "string",
                enum: ["api", "full", "examples", "types"],
                description: "Level of detail (default: api)",
              },
              ...LIBRARY_PROPERTY,
            },
            required: ["componentNames"],
          },
        },
        {
          name: "validate_template",
          description:
            "Validate an Angular template against actual component APIs. Catches hallucinated inputs/outputs, missing required inputs, and unknown elements. For React libraries use validate_usage.",
          inputSchema: {
            type: "object",
            properties: {
              template: {
                type: "string",
                description: "Angular template string to validate",
              },
              componentNames: {
                type: "array",
                items: { type: "string" },
                description: "ALL component names used in the template",
              },
              ...LIBRARY_PROPERTY,
            },
            required: ["template", "componentNames"],
          },
        },
        {
          name: "validate_usage",
          description:
            "Validate a usage snippet against actual component APIs, dispatched by the library's framework: JSX/TSX for React libraries, Angular templates for Angular libraries. Catches hallucinated props, missing required props, and offers spelling suggestions. Spread props ({...x}) skip required-prop checks.",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "Usage snippet to validate (JSX for React, template HTML for Angular)",
              },
              componentNames: {
                type: "array",
                items: { type: "string" },
                description: "ALL component names used in the snippet",
              },
              ...LIBRARY_PROPERTY,
            },
            required: ["code", "componentNames"],
          },
        },
      ],
    };
  });
}
