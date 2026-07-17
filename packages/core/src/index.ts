/**
 * @cl-mcp/core
 *
 * Transport-agnostic core of cl-mcp: metadata loading (multi-library
 * registry), the search/resolution domain, and the tool handlers. Both
 * frontends are thin adapters over this package:
 *
 *   - `@cl-mcp/mcp-server` — MCP protocol (stdio) adapter
 *   - `@cl-mcp/cli`        — shell adapter
 *
 * Importing this package has no side effects; call `loadPreloadedMetadata()`
 * before using any accessor or handler.
 */

// ── Configuration ───────────────────────────────────────────────────
export { METADATA_FILENAME, getLibraryConfig, setLibraryConfig, type LibraryConfig } from "./config.js";

// ── Data layer ──────────────────────────────────────────────────────
export {
  buildImportedByIndex,
  componentExists,
  getAnalyzedEntry,
  getAvailableComponents,
  getComponentAnalysis,
  getMetadata,
  getPreloadedComponentMetadata,
  loadPreloadedMetadata,
} from "./data/metadata.js";
export {
  __resetRegistryForTests,
  __setLibrariesForTests,
  getActiveLibrary,
  getLibraryNames,
  isMultiLibrary,
  resolveLibraryQualifier,
  setActiveLibrary,
  withLibrary,
  type LoadedLibrary,
} from "./data/registry.js";
export { resolveAllMetadataPaths, resolveMetadataPath } from "./data/paths.js";
export { ComponentMetadataFileSchema, parseComponentMetadata } from "./data/schema.js";

// ── Domain layer ────────────────────────────────────────────────────
export { formatQuickContextForLLM, generateQuickContext, getQuickContext } from "./domain/context.js";
export { resolveComponentName } from "./domain/resolver.js";
export { searchComponents, type ComponentSearchMeta, type SearchResult } from "./domain/search.js";

// ── Application layer (tool handlers) ───────────────────────────────
export { TOOL_HANDLERS, type ToolResponse } from "./handlers.js";

// ── Shared types (re-exported from @cl-mcp/analyzer) ────────────────
export type {
  AnalyzedComponentEntry,
  AnalyzerDiagnostic,
  ComponentAnalysis,
  ComponentMetadataEntry,
  ComponentMetadataFile,
  EnhancedComponentMetadataEntry,
  FileAnalysis,
  InputProperty,
  OutputProperty,
  QuickContext,
  SelectorQuickInfo,
  StrictComponentAPI,
  ValidationResult,
} from "./types.js";
export { JsxValidator, TemplateValidator, formatValidationResult } from "./types.js";
