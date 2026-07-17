/**
 * Tool handlers — the application layer of cl-mcp.
 *
 * Transport-agnostic: every handler is a pure `args → ToolResponse` function
 * with NO dependency on the MCP SDK or any I/O channel. The MCP server
 * (`@cl-mcp/mcp-server`) registers these behind `tools/call`; the CLI
 * (`@cl-mcp/cli`) invokes them directly. Both frontends therefore share one
 * implementation by construction.
 *
 * Multi-library mode: every tool accepts an optional `library` argument, and
 * component names accept a `lib:Name` qualifier. When neither is given, the
 * handler resolves the component across ALL loaded libraries (unambiguous hit
 * wins; ambiguity returns qualified suggestions). Handlers compute
 * synchronously, so switching the active library per request is safe.
 */

import { getLibraryConfig } from "./config.js";
import { componentExists, getAnalyzedEntry, getAvailableComponents, getComponentAnalysis } from "./data/metadata.js";
import { getLibraryNames, isMultiLibrary, resolveLibraryQualifier, withLibrary } from "./data/registry.js";
import { formatQuickContextForLLM, getQuickContext } from "./domain/context.js";
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
} from "./domain/formatters.js";
import { resolveComponentName } from "./domain/resolver.js";
import { JsxValidator, TemplateValidator, formatValidationResult } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────

type DetailLevel = "api" | "full" | "examples" | "types";

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

const MAX_TEMPLATE_LENGTH = 100_000;

// ── Library targeting helpers ─────────────────────────────────────

/** Resolve the optional `library` argument. */
function resolveLibraryArg(args: Record<string, unknown>): { library?: string; error?: ToolResponse } {
  const raw = args.library;
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return { error: errorResponse("Error: library must be a string.") };
  const resolved = resolveLibraryQualifier(raw);
  if (!resolved) {
    return { error: errorResponse(`Error: unknown library "${raw}". Available: ${getLibraryNames().join(", ")}`) };
  }
  return { library: resolved };
}

/** Split a `lib:Name` qualifier. Returns null library when unqualified. */
function splitQualifiedName(name: string): { library: string | null; componentName: string; error?: ToolResponse } {
  const idx = name.indexOf(":");
  if (idx === -1) return { library: null, componentName: name };
  const qualifier = name.slice(0, idx).trim();
  const rest = name.slice(idx + 1).trim();
  const resolved = resolveLibraryQualifier(qualifier);
  if (!resolved) {
    return {
      library: null,
      componentName: rest,
      error: errorResponse(
        `Error: unknown library qualifier "${qualifier}" in "${name}". Available: ${getLibraryNames().join(", ")}`,
      ),
    };
  }
  return { library: resolved, componentName: rest };
}

interface ComponentTarget {
  library: string;
  resolved: string;
  matchedSelector?: string;
}

/**
 * Resolve a (possibly qualified) component name to a concrete library +
 * component. Explicit qualifier/argument wins; otherwise every library is
 * tried and exactly one hit is required.
 */
function resolveComponentTarget(
  rawName: string,
  libraryArg?: string,
): { target?: ComponentTarget; error?: ToolResponse } {
  const split = splitQualifiedName(rawName);
  if (split.error) return { error: split.error };
  const explicitLibrary = split.library ?? libraryArg;

  if (explicitLibrary) {
    return withLibrary(explicitLibrary, () => {
      const result = requireComponent(split.componentName);
      if ("error" in result) return { error: result.error };
      return {
        target: { library: explicitLibrary, resolved: result.resolved, matchedSelector: result.matchedSelector },
      };
    });
  }

  const hits: ComponentTarget[] = [];
  const suggestionPool: string[] = [];
  for (const lib of getLibraryNames()) {
    withLibrary(lib, () => {
      const result = resolveComponentName(split.componentName);
      if ("resolved" in result) {
        hits.push({ library: lib, resolved: result.resolved, matchedSelector: result.matchedSelector });
      } else if ("suggestions" in result) {
        suggestionPool.push(...result.suggestions.map((s) => `${lib}:${s}`));
      }
    });
  }

  if (hits.length === 1) return { target: hits[0] };
  if (hits.length > 1) {
    const qualified = hits.map((h) => `${h.library}:${h.resolved}`);
    return {
      error: errorResponse(
        `Error: "${split.componentName}" matches components in multiple libraries: ${qualified.join(", ")}. ` +
          `Qualify the name (e.g. "${qualified[0]}") or pass the "library" argument.`,
      ),
    };
  }
  if (suggestionPool.length > 0) {
    return {
      error: errorResponse(`Component "${split.componentName}" not found. Did you mean: ${suggestionPool.join(", ")}?`),
    };
  }
  return {
    error: errorResponse(
      `Component "${split.componentName}" not found in any library (${getLibraryNames().join(", ")}).`,
    ),
  };
}

/** Header line naming the library — only added in multi-library mode. */
function libraryHeader(library: string): string {
  return isMultiLibrary() ? `**Library:** \`${library}\`\n\n` : "";
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

function formatTarget(level: DetailLevel, target: ComponentTarget): ToolResponse {
  return withLibrary(target.library, () => {
    const response = formatByDetailLevel(level, target.resolved, target.matchedSelector);
    if (response.isError) return response;
    return {
      ...response,
      content: [{ type: "text" as const, text: libraryHeader(target.library) + response.content[0].text }],
    };
  });
}

// ── Tool handlers ──────────────────────────────────────────────────

function handleLibraryOverview(args: Record<string, unknown>): ToolResponse {
  const { format } = args as { format?: "text" | "json" };
  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;

  const targets = libArg.library ? [libArg.library] : getLibraryNames();

  if (format === "json") {
    if (targets.length === 1) return withLibrary(targets[0], () => jsonResponse(getQuickContext()));
    const combined: Record<string, unknown> = {};
    for (const lib of targets) {
      combined[lib] = withLibrary(lib, () => getQuickContext());
    }
    return jsonResponse({ libraries: combined });
  }

  if (targets.length === 1) return withLibrary(targets[0], () => textResponse(formatQuickContextForLLM()));

  const sections = [
    `# Component Libraries (${targets.length})\n\n${targets
      .map((lib) =>
        withLibrary(
          lib,
          () => `- \`${lib}\` — ${getLibraryConfig().packageName} (${getLibraryConfig().framework ?? "angular"})`,
        ),
      )
      .join(
        "\n",
      )}\n\nQualify component names as \`<library>:<component>\` or pass the \`library\` argument to scope any tool.`,
    ...targets.map((lib) => withLibrary(lib, () => `# Library: ${lib}\n\n${formatQuickContextForLLM()}`)),
  ];
  return textResponse(sections.join("\n\n---\n\n"));
}

function handleFindComponents(args: Record<string, unknown>): ToolResponse {
  const { query, list_all } = args as { query?: string; list_all?: boolean };
  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;

  const targets = libArg.library ? [libArg.library] : getLibraryNames();

  if (targets.length === 1) {
    return withLibrary(targets[0], () => {
      const components = getAvailableComponents();
      if (query) return handleComponentSearch(query, components);
      return handleComponentListing(components, list_all);
    });
  }

  const sections = targets.map((lib) =>
    withLibrary(lib, () => {
      const components = getAvailableComponents();
      const response = query ? handleComponentSearch(query, components) : handleComponentListing(components, list_all);
      return `# Library: ${lib}\n\n${response.content[0].text}`;
    }),
  );
  return textResponse(sections.join("\n\n---\n\n"));
}

function handleGetComponent(args: Record<string, unknown>): ToolResponse {
  const { componentName, detail_level } = args as { componentName: string; detail_level?: DetailLevel };

  if (!componentName || typeof componentName !== "string") {
    return errorResponse("Error: componentName is required and must be a string.");
  }
  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;

  const { target, error } = resolveComponentTarget(componentName, libArg.library);
  if (error || !target) return error ?? errorResponse("Component resolution failed.");

  try {
    return formatTarget(detail_level || "api", target);
  } catch (err) {
    return errorResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleGetComponentsBatch(args: Record<string, unknown>): ToolResponse {
  const { componentNames, detail_level } = args as { componentNames: string[]; detail_level?: DetailLevel };

  if (!Array.isArray(componentNames) || componentNames.length === 0) {
    return errorResponse("Error: componentNames must be a non-empty array of strings.");
  }
  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;

  const level = detail_level || "api";
  const sections: string[] = [];

  for (const componentName of componentNames) {
    const { target, error } = resolveComponentTarget(componentName, libArg.library);
    if (error || !target) {
      const msg = error?.content[0].text ?? "Component resolution failed.";
      sections.push(`# ${componentName}\n\n**Error:** ${msg}\n`);
      continue;
    }
    try {
      const response = formatTarget(level, target);
      sections.push(response.content[0].text);
    } catch (err) {
      sections.push(`# ${componentName}\n\n**Error:** ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return textResponse(sections.join("\n---\n\n"));
}

// ── Validation ─────────────────────────────────────────────────────

/**
 * Pick the library whose metadata contains ALL of the given component names.
 * Explicit choice wins; otherwise exactly one candidate library must match.
 */
function resolveValidationLibrary(
  componentNames: string[],
  explicit?: string,
): { library?: string; error?: ToolResponse } {
  if (explicit) return { library: explicit };

  const candidates = getLibraryNames().filter((lib) =>
    withLibrary(lib, () => componentNames.every((name) => componentExists(name))),
  );
  if (candidates.length === 1) return { library: candidates[0] };
  if (candidates.length === 0) {
    // Fall back to libraries containing at least one of the names.
    const partial = getLibraryNames().filter((lib) =>
      withLibrary(lib, () => componentNames.some((name) => componentExists(name))),
    );
    if (partial.length === 1) return { library: partial[0] };
    return {
      error: errorResponse(
        `Error: none of the libraries (${getLibraryNames().join(", ")}) contains the named components. Check the names or pass the "library" argument.`,
      ),
    };
  }
  return {
    error: errorResponse(
      `Error: components exist in multiple libraries (${candidates.join(", ")}). Pass the "library" argument.`,
    ),
  };
}

function validateAngularTemplate(template: string, componentNames: string[]): ToolResponse {
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

function validateReactUsage(code: string, componentNames: string[]): ToolResponse {
  const validator = new JsxValidator();
  for (const compName of componentNames) {
    if (componentExists(compName)) {
      validator.registerFromAnalysis(getComponentAnalysis(compName));
    }
  }

  const result = validator.validate(code);

  if (result.errors.length === 0) {
    const notes = result.suggestions.length > 0 ? ` Notes: ${result.suggestions.join(" ")}` : "";
    return jsonResponse({
      valid: true,
      message: `JSX usage is valid. All props exist on the specified components.${notes}`,
      registeredComponents: validator.registeredComponents,
    });
  }

  return {
    content: [{ type: "text" as const, text: formatValidationResult(result) }],
    isError: true as const,
  };
}

function checkValidationInput(code: unknown, componentNames: unknown, codeLabel: string): ToolResponse | null {
  if (!code || typeof code !== "string") {
    return errorResponse(`Error: ${codeLabel} parameter is required and must be a string.`);
  }
  if (code.length > MAX_TEMPLATE_LENGTH) {
    return errorResponse(
      `Error: ${codeLabel} exceeds maximum length of ${MAX_TEMPLATE_LENGTH} characters (got ${code.length}).`,
    );
  }
  if (!Array.isArray(componentNames) || componentNames.length === 0) {
    return errorResponse("Error: componentNames must be a non-empty array of strings.");
  }
  return null;
}

function handleValidateTemplate(args: Record<string, unknown>): ToolResponse {
  const { template, componentNames } = args as { template: string; componentNames: string[] };
  const inputError = checkValidationInput(template, componentNames, "template");
  if (inputError) return inputError;

  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;
  const { library, error } = resolveValidationLibrary(componentNames, libArg.library);
  if (error || !library) return error ?? errorResponse("Library resolution failed.");

  return withLibrary(library, () => {
    if ((getLibraryConfig().framework ?? "angular") === "react") {
      return errorResponse(
        `Error: library "${library}" is a React library — validate_template checks Angular templates. Use validate_usage instead.`,
      );
    }
    return validateAngularTemplate(template, componentNames);
  });
}

function handleValidateUsage(args: Record<string, unknown>): ToolResponse {
  const { code, componentNames } = args as { code: string; componentNames: string[] };
  const inputError = checkValidationInput(code, componentNames, "code");
  if (inputError) return inputError;

  const libArg = resolveLibraryArg(args);
  if (libArg.error) return libArg.error;
  const { library, error } = resolveValidationLibrary(componentNames, libArg.library);
  if (error || !library) return error ?? errorResponse("Library resolution failed.");

  return withLibrary(library, () => {
    const framework = getLibraryConfig().framework ?? "angular";
    return framework === "react"
      ? validateReactUsage(code, componentNames)
      : validateAngularTemplate(code, componentNames);
  });
}

// ── Dispatch table ─────────────────────────────────────────────────

export const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => ToolResponse> = {
  get_library_overview: handleLibraryOverview,
  find_components: handleFindComponents,
  get_component: handleGetComponent,
  get_components_batch: handleGetComponentsBatch,
  validate_template: handleValidateTemplate,
  validate_usage: handleValidateUsage,
};
