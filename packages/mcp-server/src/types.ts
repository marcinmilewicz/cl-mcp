/**
 * Type re-exports from @cl-mcp/analyzer.
 * Single import path for MCP server consumers.
 */

export type {
  FileAnalysis,
  AnalyzedComponentEntry,
  ComponentMetadataEntry,
  ComponentMetadataFile,
  SelectorQuickInfo,
  EnhancedComponentMetadataEntry,
  ComponentAnalysis,
  StrictComponentAPI,
  QuickContext,
  ValidationResult,
  InputProperty,
  OutputProperty,
  AnalyzerDiagnostic,
} from "@cl-mcp/analyzer";

export {
  TemplateValidator,
  buildStrictAPIFromAnalysis,
  formatValidationResult,
  generateInputExample,
  capitalize,
} from "@cl-mcp/analyzer";
