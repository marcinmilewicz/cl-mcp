/**
 * MCP Tool Request Router
 *
 * Thin routing layer that maps incoming MCP tool requests to handler functions.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getLibraryConfig } from "../config.js";
import { componentExists, getAnalyzedEntry, getAvailableComponents, getComponentAnalysis } from "../data/metadata.js";
import { formatQuickContextForLLM, getQuickContext } from "../domain/context.js";
import {
  errorResponse,
  handleComponentApi,
  handleComponentExamples,
  handleComponentFull,
  handleComponentListing,
  handleComponentSearch,
  handleComponentTypes,
  jsonResponse,
  requireComponent,
  textResponse,
} from "../domain/formatters.js";
import { resolveComponentName } from "../domain/resolver.js";
import { TemplateValidator, formatValidationResult } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────

type DetailLevel = "api" | "full" | "examples" | "types";

interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

// ── Detail-level dispatch ─────────────────────────────────────────

function formatByDetailLevel(level: DetailLevel, resolvedName: string, matchedSelector?: string): ToolResponse {
  switch (level) {
    case "api":
      return handleComponentApi(resolvedName, matchedSelector);
    case "full":
      return handleComponentFull(resolvedName);
    case "examples":
      return handleComponentExamples(resolvedName);
    case "types":
      return handleComponentTypes(resolvedName, matchedSelector);
    default:
      return errorResponse(`Unknown detail_level: "${level}". Use: api, full, examples, types.`);
  }
}

// ── Tool handlers ──────────────────────────────────────────────────

function handleLibraryOverview(args: Record<string, unknown>): ToolResponse {
  const { format } = args as { format?: "text" | "json" };
  if (format === "json") return jsonResponse(getQuickContext());
  return textResponse(formatQuickContextForLLM());
}

function handleFindComponents(args: Record<string, unknown>): ToolResponse {
  const { query, list_all } = args as { query?: string; list_all?: boolean };
  const components = getAvailableComponents();
  if (query) return handleComponentSearch(query, components);
  return handleComponentListing(components, list_all);
}

function handleGetComponent(args: Record<string, unknown>): ToolResponse {
  const { componentName, detail_level } = args as { componentName: string; detail_level?: DetailLevel };

  if (!componentName || typeof componentName !== "string") {
    return errorResponse("Error: componentName is required and must be a string.");
  }

  const resolved = requireComponent(componentName);
  if ("error" in resolved) return resolved.error;

  try {
    return formatByDetailLevel(detail_level || "api", resolved.resolved, resolved.matchedSelector);
  } catch (error) {
    return errorResponse(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleGetComponentsBatch(args: Record<string, unknown>): ToolResponse {
  const { componentNames, detail_level } = args as { componentNames: string[]; detail_level?: DetailLevel };

  if (!Array.isArray(componentNames) || componentNames.length === 0) {
    return errorResponse("Error: componentNames must be a non-empty array of strings.");
  }

  const level = detail_level || "api";
  const sections: string[] = [];

  for (const componentName of componentNames) {
    const resolved = resolveComponentName(componentName);

    if (!("resolved" in resolved)) {
      const msg =
        "suggestions" in resolved ? `Did you mean: ${resolved.suggestions.join(", ")}?` : `Component does not exist.`;
      sections.push(`# ${componentName}\n\n**Error:** ${msg}\n`);
      continue;
    }

    try {
      const response = formatByDetailLevel(level, resolved.resolved, resolved.matchedSelector);
      sections.push(response.content[0].text);
    } catch (error) {
      sections.push(`# ${componentName}\n\n**Error:** ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  return textResponse(sections.join("\n---\n\n"));
}

function handleValidateTemplate(args: Record<string, unknown>): ToolResponse {
  const { template, componentNames } = args as { template: string; componentNames: string[] };
  const MAX_TEMPLATE_LENGTH = 100_000;

  if (!template || typeof template !== "string") {
    return errorResponse("Error: template parameter is required and must be a string.");
  }
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return errorResponse(
      `Error: Template exceeds maximum length of ${MAX_TEMPLATE_LENGTH} characters (got ${template.length}).`,
    );
  }
  if (!Array.isArray(componentNames) || componentNames.length === 0) {
    return errorResponse("Error: componentNames must be a non-empty array of strings.");
  }

  const libConfig = getLibraryConfig();
  const validator = new TemplateValidator({
    selectorPrefix: libConfig.selectorPrefix,
    libraryName: libConfig.name,
  });

  for (const compName of componentNames) {
    if (componentExists(compName)) {
      const analyses = getComponentAnalysis(compName);
      validator.registerFromAnalysis(analyses);

      const preloaded = getAnalyzedEntry(compName);
      if (preloaded?.inheritance) {
        for (const inh of Object.values(preloaded.inheritance)) {
          validator.registerInheritedProperties(inh.inheritedInputs || [], inh.inheritedOutputs || []);
        }
      }
    }
  }

  const result = validator.validate(template);

  if (result.errors.length === 0) {
    return jsonResponse({
      valid: true,
      message: "Template is valid. All inputs and outputs exist on the specified components.",
      registeredSelectors: validator.getRegisteredSelectors(),
    });
  }

  return {
    content: [{ type: "text" as const, text: formatValidationResult(result) }],
    isError: true as const,
  };
}

// ── Dispatch table & registration ─────────────────────────────────

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => ToolResponse> = {
  get_library_overview: handleLibraryOverview,
  find_components: handleFindComponents,
  get_component: handleGetComponent,
  get_components_batch: handleGetComponentsBatch,
  validate_template: handleValidateTemplate,
};

export function registerToolHandlers(server: Server): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = TOOL_HANDLERS[name];

    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    return handler(args as Record<string, unknown>) as any;
  });
}
