/**
 * @cl-mcp/analyzer
 *
 * Build-time analysis tools for component libraries.
 * Provides AST analysis, metadata generation, template validation, and type definitions.
 */

// Core types
export type {
  ComponentMetadata,
  InputProperty,
  OutputProperty,
  PublicMethod,
  MethodParameter,
  InjectedDependency,
  ExportedType,
  TypeMember,
  LifecycleHook,
  ComponentAnalysis,
  FileAnalysis,
  PipeAnalysis,
  ServiceAnalysis,
  ExportedFunction,
  ComponentSummary,
  ComponentDependencies,
  ComponentProviders,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  StrictComponentAPI,
  StrictInput,
  StrictOutput,
  ContentSlot,
  FormControlInfo,
  SelectorQuickInfo,
  QuickContext,
  InheritanceInfo,
  ContentSlotInfo,
  DeprecationInfo,
  ConfigTokenInfo,
  StorybookExample,
  RelatedComponent,
  ImportGraphEntry,
  EnhancedComponentMetadataEntry,
  AnalyzedComponentEntry,
  SkippedComponentEntry,
  FailedComponentEntry,
  ComponentMetadataEntry,
  ComponentMetadataBase,
  EnumMember,
  ComponentMetadataFile,
  AnalyzerOptions,
  FrameworkAnalyzer,
  SupportedFramework,
  AnalyzerDiagnostic,
  ResolvedValues,
  FilePath,
  ClassName,
  Selector,
  Mutable,
} from "./types.js";

export { asFilePath, asClassName, asSelector } from "./types.js";

// Inheritance result helper (v4.0 — breaking signature change to analyzeInheritance).
export type { InheritanceResult } from "./analyzers/angular/angular-analyzer.js";

// Diagnostics
export { DiagnosticsCollector } from "./shared/diagnostics.js";

// Template Validator
export {
  TemplateValidator,
  buildStrictAPIFromAnalysis,
  formatValidationResult,
  generateInputExample,
  capitalize,
} from "./shared/template-validator.js";

// Angular Analyzer
export { AngularAstAnalyzer } from "./analyzers/angular/angular-analyzer.js";

// Framework analyzers (the `FrameworkAnalyzer` seam)
export {
  AngularFrameworkAnalyzer,
  METADATA_SCHEMA_VERSION,
} from "./analyzers/angular/angular-framework-analyzer.js";
export { ReactFrameworkAnalyzer } from "./analyzers/react/react-framework-analyzer.js";
export { ReactAstAnalyzer, parseDeprecationText } from "./analyzers/react/react-analyzer.js";
export { JsxValidator } from "./analyzers/react/jsx-validator.js";

// Workspace layer (multi-library discovery + orchestration)
export type { WorkspaceManifest } from "./types.js";
export {
  loadWorkspaceConfig,
  findWorkspaceConfig,
  WorkspaceConfigSchema,
  type WorkspaceConfig,
  type LibraryEntry,
  type ComponentLayout,
} from "./workspace/config.js";
export { detectFramework } from "./workspace/framework-detector.js";
export { resolveLibraries, type ResolvedLibrary } from "./workspace/library-discovery.js";
export { analyzeWorkspace, type WorkspaceAnalysisResult } from "./workspace/workspace-orchestrator.js";
