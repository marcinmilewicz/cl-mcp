import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export function registerToolDefinitions(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_library_overview",
          description:
            "Start here → find_components → get_component → validate_template. Returns a compact reference of all components with their selectors, inputs map, critical rules, plus directive and pipe listings.",
          inputSchema: {
            type: "object",
            properties: {
              format: {
                type: "string",
                enum: ["text", "json"],
                description: "Output format (default: text)",
              },
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
            },
            required: [],
          },
        },
        {
          name: "get_component",
          description:
            'Get detailed information about a single component. detail_level: "api" (default) = strict input/output reference, "full" = complete with inheritance/config, "examples" = usage patterns, "types" = TypeScript types.',
          inputSchema: {
            type: "object",
            properties: {
              componentName: {
                type: "string",
                description: "Component name or selector",
              },
              detail_level: {
                type: "string",
                enum: ["api", "full", "examples", "types"],
                description: "Level of detail (default: api)",
              },
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
                description: "Array of component names",
              },
              detail_level: {
                type: "string",
                enum: ["api", "full", "examples", "types"],
                description: "Level of detail (default: api)",
              },
            },
            required: ["componentNames"],
          },
        },
        {
          name: "validate_template",
          description:
            "Validate an Angular template against actual component APIs. Catches hallucinated inputs/outputs, missing required inputs, and unknown elements.",
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
            },
            required: ["template", "componentNames"],
          },
        },
      ],
    };
  });
}
