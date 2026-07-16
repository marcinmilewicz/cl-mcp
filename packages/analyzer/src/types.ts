/**
 * Core type definitions for the component metadata system.
 *
 * These types define the canonical schema for component-metadata.json (v4.0).
 * They are framework-agnostic where possible, with Angular-specific types
 * clearly scoped.
 *
 * Schema v4.0 (BREAKING) — type-bearing fields use `string | null` plus a
 * `typeResolved: boolean` flag instead of the legacy `'unknown'` / `'void'`
 * sentinel strings. `resolvedValues` is now `{ values, partial } | null`.
 *
 * Phase 5: `readonly` arrays (source-only — wire format unchanged), literal
 * union enums, and brand types for `FilePath`/`ClassName`/`Selector`.
 */

// ============================================================================
// Brand types (compile-time only; erased at runtime)
// ============================================================================

declare const __brand: unique symbol;

export type FilePath = string & { readonly [__brand]: "FilePath" };
export type ClassName = string & { readonly [__brand]: "ClassName" };
export type Selector = string & { readonly [__brand]: "Selector" };

/**
 * Unchecked branded-string constructors. These are trust-boundary asserts, not
 * validators — producers call them at the edge where a plain `string` becomes
 * a semantically-typed identifier. No runtime validation is performed.
 */
export const asFilePath = (s: string): FilePath => s as FilePath;
export const asClassName = (s: string): ClassName => s as ClassName;
export const asSelector = (s: string): Selector => s as Selector;

/**
 * Internal helper to strip `readonly` from array fields when a producer needs
 * to mutate during construction. Never escape this beyond the file that
 * builds the value.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };

// ============================================================================
// AST Analysis Types (produced by framework analyzers)
// ============================================================================

/**
 * Structural portion of `ComponentMetadata` that is common to every variant.
 * The template source is modelled separately as an XOR union below.
 */
export interface ComponentMetadataBase {
  selector: Selector;
  standalone: boolean;
  changeDetection?: "OnPush" | "Default" | null;
  encapsulation?: "None" | "Emulated" | "ShadowDom" | null;
  exportAs?: string;
  styleUrls?: readonly string[];
  imports?: readonly string[];
  providers?: readonly string[];
}

/**
 * XOR template source: at most ONE of `template` (inline) or `templateUrl`
 * (external) may be set. Directives typically carry neither.
 *
 * Both-set would be a producer bug (the analyzer should pick one); neither
 * is legal for directives and for components the analyzer emits a diagnostic.
 */
export type ComponentMetadata =
  | (ComponentMetadataBase & { template?: undefined; templateUrl?: undefined })
  | (ComponentMetadataBase & { template: string; templateUrl?: undefined })
  | (ComponentMetadataBase & { template?: undefined; templateUrl: string });

/**
 * Resolved literal-union values for an input. `partial: true` means the
 * source union mixed literal members with non-literal ones (e.g.
 * `'a' | 'b' | SomeAlias`); only the literal members are included in
 * `values`. `null` when the type isn't a literal union or couldn't be
 * resolved.
 */
export interface ResolvedValues {
  values: readonly string[];
  partial: boolean;
}

/**
 * Shared fields for all `InputProperty` variants. The `required` flag
 * discriminates between the two variants: a required input cannot carry a
 * `defaultValue` (Angular forbids it at runtime), so that field is only
 * permitted when `required: false`.
 */
interface InputPropertyBase {
  name: string;
  /** `null` when the type couldn't be resolved from source. See `typeResolved`. */
  type: string | null;
  /**
   * `false` when `type` is `null` OR a fallback was forced. v4.0+.
   */
  typeResolved: boolean;
  alias?: string;
  description?: string;
  transform?: string;
  resolvedValues: ResolvedValues | null;
}

export type InputProperty =
  | (InputPropertyBase & { required: true })
  | (InputPropertyBase & { required: false; defaultValue?: string });

export interface OutputProperty {
  name: string;
  /** `null` when the event type couldn't be resolved from source. */
  eventType: string | null;
  eventTypeResolved: boolean;
  alias?: string;
  description?: string;
}

export interface PublicMethod {
  name: string;
  parameters: readonly MethodParameter[];
  /** `null` when the return type couldn't be resolved (no annotation, no inference). */
  returnType: string | null;
  returnTypeResolved: boolean;
  description?: string;
  isAsync: boolean;
}

export interface MethodParameter {
  name: string;
  /** `null` when the parameter type couldn't be resolved from source. */
  type: string | null;
  typeResolved: boolean;
  optional: boolean;
  defaultValue?: string;
}

interface InjectedDependencyBase {
  name: string;
  /** `null` when the dependency type couldn't be resolved from source. */
  type: string | null;
  typeResolved: boolean;
  injectionToken?: string;
  optional: boolean;
  host: boolean;
}

/**
 * `@Self()` and `@SkipSelf()` are mutually exclusive per Angular DI (they
 * target opposite ends of the element injector tree). When `self: true`,
 * `skipSelf` is forced to `false`.
 */
export type InjectedDependency =
  | (InjectedDependencyBase & { self: true; skipSelf: false })
  | (InjectedDependencyBase & { self: false; skipSelf: boolean });

/**
 * Discriminated union on `kind`. Member shape varies per kind:
 *   - `interface`, `type`, `class` carry `TypeMember[]`
 *   - `enum` carries enum members (name + string/number value)
 *   - `type` aliases that resolve to a primitive or union carry no members
 *
 * The analyzer currently only populates `members` for interfaces and classes;
 * `type` and `enum` entries remain structurally opaque (string `definition`
 * only). The variant boundary makes that explicit.
 */
export type ExportedType =
  | {
      name: string;
      kind: "interface" | "class";
      definition: string;
      members?: readonly TypeMember[];
    }
  | {
      name: string;
      kind: "type";
      definition: string;
    }
  | {
      name: string;
      kind: "enum";
      definition: string;
      members?: readonly EnumMember[];
    };

export interface EnumMember {
  name: string;
  value?: string;
}

export interface TypeMember {
  name: string;
  /** `null` when the member type couldn't be resolved from source. */
  type: string | null;
  typeResolved: boolean;
  optional: boolean;
  description?: string;
}

export interface LifecycleHook {
  name: string;
  implemented: boolean;
}

export interface ComponentAnalysis {
  className: ClassName;
  filePath: FilePath;
  metadata: ComponentMetadata;
  inputs: readonly InputProperty[];
  outputs: readonly OutputProperty[];
  publicMethods: readonly PublicMethod[];
  dependencies: readonly InjectedDependency[];
  lifecycleHooks: readonly LifecycleHook[];
  exportedTypes: readonly ExportedType[];
  jsDocDescription?: string;
}

export interface FileAnalysis {
  filePath: FilePath;
  components: readonly ComponentAnalysis[];
  directives: readonly ComponentAnalysis[];
  pipes: readonly PipeAnalysis[];
  services: readonly ServiceAnalysis[];
  exportedTypes: readonly ExportedType[];
  exportedFunctions: readonly ExportedFunction[];
}

export interface PipeAnalysis {
  className: ClassName;
  pipeName: string;
  pure: boolean;
  standalone: boolean;
  transformMethod?: PublicMethod;
}

export interface ServiceAnalysis {
  className: ClassName;
  providedIn?: "root" | "platform" | "any" | null;
  dependencies: readonly InjectedDependency[];
  publicMethods: readonly PublicMethod[];
}

export interface ExportedFunction {
  name: string;
  parameters: readonly MethodParameter[];
  /** `null` when the return type couldn't be resolved from source. */
  returnType: string | null;
  returnTypeResolved: boolean;
  description?: string;
  isAsync: boolean;
}

// ============================================================================
// Component Summary Types
// ============================================================================

export interface ComponentSummary {
  name: string;
  exports: readonly string[];
  selector?: Selector;
  description?: string;
  relatedComponents?: readonly string[];
}

// ============================================================================
// Dependency Types
// ============================================================================

export interface ComponentDependencies {
  required: readonly string[];
  optional: readonly string[];
}

export interface ComponentProviders {
  required: readonly string[];
  optional: readonly string[];
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Source span within a validated template. Additive since schema v4.1:
 * populated by the AST-based validator when the originating node carries
 * a `sourceSpan`. Older (regex-based) call-paths leave it unset.
 */
export interface TemplateSourceSpan {
  line: number;
  column: number;
  length: number;
}

/**
 * `valid` was removed in v4.0 — derive from `errors.length === 0` at read sites.
 */
export interface ValidationResult {
  errors: readonly ValidationError[];
  warnings: readonly ValidationWarning[];
  suggestions: readonly string[];
}

/**
 * Discriminated on `type`. Each variant carries only the fields that make
 * sense for that error category. `message` and optional `suggestion` are
 * common; `property` / `element` / `line` are per-variant.
 */
export type ValidationError =
  | {
      type: "unknown-input";
      message: string;
      property: string;
      element: string;
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "unknown-output";
      message: string;
      property: string;
      element: string;
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "unknown-element";
      message: string;
      element: string;
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "unknown-pipe";
      message: string;
      property: string;
      element: "pipe";
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "type-mismatch";
      message: string;
      property: string;
      element: string;
      expected?: string | null;
      actual?: string;
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "missing-required";
      message: string;
      property: string;
      element: string;
      suggestion?: string;
      sourceSpan?: TemplateSourceSpan;
    }
  | {
      type: "template-too-large";
      message: string;
      element: "";
    };

export interface ValidationWarning {
  type:
    | "deprecated"
    | "performance"
    | "accessibility"
    | "pipe-arg-count-mismatch"
    | "unknown-pipe"
    | "template-parse-failed";
  message: string;
  property?: string;
  element?: string;
  sourceSpan?: TemplateSourceSpan;
}

// ============================================================================
// Strict API Types (for LLM consumption)
// ============================================================================

export interface StrictComponentAPI {
  selector: Selector;
  className: ClassName;
  availableInputs: readonly StrictInput[];
  availableOutputs: readonly StrictOutput[];
  contentSlots: readonly ContentSlot[];
  formControl?: FormControlInfo;
  requiredProviders: readonly string[];
}

export interface StrictInput {
  name: string;
  /** `null` when the underlying input's type couldn't be resolved. */
  type: string | null;
  typeResolved: boolean;
  required: boolean;
  defaultValue?: string;
  description: string;
  example: string;
}

export interface StrictOutput {
  name: string;
  /** `null` when the underlying output's eventType couldn't be resolved. */
  eventType: string | null;
  eventTypeResolved: boolean;
  description: string;
  example: string;
}

export interface ContentSlot {
  name: string;
  selector?: Selector;
  description: string;
}

export interface FormControlInfo {
  valueType: string;
  validators?: readonly string[];
}

// ============================================================================
// Quick Context Types (for LLM efficiency)
// ============================================================================

export interface SelectorQuickInfo {
  component: string;
  type?: "component" | "directive";
  mainInputs: readonly string[];
  mainOutputs: readonly string[];
  formControl?: boolean;
  hasContentSlots?: boolean;
  deprecated?: boolean;
  configRequired?: readonly string[];
}

export interface QuickContext {
  version: string;
  totalComponents: number;
  selectorMap: Record<string, SelectorQuickInfo>;
  importCheatsheet: Record<string, string>;
}

// ============================================================================
// Phase 1: Enhanced AST Types
// ============================================================================

export interface InheritanceInfo {
  baseClass?: ClassName;
  baseClassPath?: FilePath;
  inheritedInputs: readonly InputProperty[];
  inheritedOutputs: readonly OutputProperty[];
  mixins: readonly string[];
}

export interface ContentSlotInfo {
  name: string;
  selector?: Selector;
  required: boolean;
  multiple: boolean;
  /**
   * When the `select` attribute is compound (e.g. `select="[foo], [bar]"`),
   * the primary `selector` holds the original string and `selectorAlternates`
   * holds the comma-split, trimmed parts. Undefined for simple selectors.
   * Populated only by the AST-based parser (Commit 2 migration).
   */
  selectorAlternates?: readonly string[];
}

export interface DeprecationInfo {
  deprecated: true;
  since?: string;
  removeIn?: string;
  replacement?: string;
  reason?: string;
}

export interface ConfigTokenInfo {
  token: string;
  interface: string;
  properties: readonly TypeMember[];
  defaultValues?: Record<string, unknown>;
  filePath: FilePath;
}

// ============================================================================
// Phase 2: Storybook Types
// ============================================================================

/**
 * `validated` was removed in v4.0 — derive from a separate validation pass.
 */
export interface StorybookExample {
  storyName: string;
  filePath: FilePath;
  template: string;
  args: Record<string, unknown>;
  argTypes?: Record<string, { options?: readonly string[] }>;
  usedComponents: readonly string[];
  /**
   * Structured references to components/directives used in the template.
   * New in schema v4.1 (additive). `selector` is the raw token as it appears
   * in the template (e.g. `mat-button` or `matTooltip`); `kind` distinguishes
   * element tags from attribute-directive tokens.
   */
  usedComponentRefs?: readonly { selector: string; kind: "element" | "attribute" }[];
}

// ============================================================================
// Phase 3: Import Graph Types
// ============================================================================

export interface RelatedComponent {
  name: string;
  relationship: "requires" | "often-used-with" | "alternative-to";
  reason: string;
}

/**
 * In-memory-only shape used while building the graph. The on-disk metadata
 * schema stores only `imports`; `importedBy` is computed at load time in the
 * MCP server to avoid referential-integrity drift (every `imports` edge must
 * have a matching reverse edge — keeping that invariant in the on-disk file
 * doubles the opportunity for inconsistency).
 */
export interface ImportGraphEntry {
  component: string;
  imports: readonly string[];
  importedBy: readonly string[];
}

// ============================================================================
// Phase 4: Enhanced Metadata Types (the canonical component entry)
// ============================================================================

/**
 * The canonical component entry — discriminated on `kind`.
 *
 *   - `'analyzed'` — full pipeline ran, AST + enhancements + graph all present.
 *   - `'skipped'` — intentionally not analyzed (anonymous class, filtered
 *     selector, etc.). Carries only `name` + `reason`.
 *   - `'failed'` — the component-analysis catch site fired; we know the
 *     `name` but no payload could be produced.
 *
 * Consumers must narrow on `kind` before reading analysis-related fields.
 *
 * Note on referential integrity: `importsFrom` is serialized; `importedBy`
 * is computed at load time in the MCP server from the reverse index.
 */
export type EnhancedComponentMetadataEntry = AnalyzedComponentEntry | SkippedComponentEntry | FailedComponentEntry;

export interface AnalyzedComponentEntry {
  kind: "analyzed";
  name: string;
  exports: readonly string[];
  files: readonly string[];
  readme?: string;
  analysis: readonly FileAnalysis[];
  dependencies: {
    required: readonly string[];
    optional: readonly string[];
    providers: {
      required: readonly string[];
      optional: readonly string[];
    };
  };
  examples: ReadonlyArray<{
    name: string;
    description: string;
    template?: string;
    typescript?: string;
    scss?: string;
  }>;

  // Enhanced fields (optional)
  inheritance?: Record<string, InheritanceInfo>;
  contentProjection?: readonly ContentSlotInfo[];
  deprecation?: DeprecationInfo;
  configTokens?: readonly ConfigTokenInfo[];
  storybookExamples?: readonly StorybookExample[];
  /**
   * Reverse-index entry populated at MCP-server load time from every other
   * entry's `importsFrom`. Never emitted by the analyzer; present at runtime
   * only. Producers must NOT write this field.
   */
  importedBy?: readonly string[];
  importsFrom?: readonly string[];
  relatedComponents?: readonly RelatedComponent[];
  llmSummary?: string;
  commonPatterns?: readonly string[];

  /**
   * `false` when inheritance analysis hit any kind of unresolvable import
   * for this entry. Always `true` when the entry has no `extends` clause OR
   * when every base class import resolved successfully (schema v4.0:
   * required, no longer optional). The same-file fallback removed in v4.0.
   */
  inheritanceResolved: boolean;
}

export interface SkippedComponentEntry {
  kind: "skipped";
  name: string;
  reason: string;
}

export interface FailedComponentEntry {
  kind: "failed";
  name: string;
  reason: string;
}

/** Alias for EnhancedComponentMetadataEntry — the canonical component metadata shape. */
export type ComponentMetadataEntry = EnhancedComponentMetadataEntry;

export interface ComponentMetadataFile {
  version: string;
  generatedAt: string;
  /**
   * Which framework analyzer produced this file. Introduced in schema v4.2
   * (additive); absent means `"angular"` (every pre-v4.2 file was Angular).
   */
  framework?: SupportedFramework;
  /**
   * Canonical package/library name (e.g. `@angular/material`). Introduced in
   * schema v4.2 (additive). Consumers should prefer this over deriving the
   * name from `componentsPath`.
   */
  libraryName?: string;
  componentsPath: string;
  importPrefix?: string;
  libraryDocumentation?: string;
  components: Record<string, ComponentMetadataEntry>;
  selectorMap?: Record<string, SelectorQuickInfo>;
  /**
   * Non-fatal analyzer diagnostics surfaced from the generation run.
   * Introduced in schema v3.1 (additive).
   */
  diagnostics?: readonly AnalyzerDiagnostic[];
}

/**
 * Workspace manifest (`workspace-manifest.json`) — describes a multi-library
 * analysis run. Written next to the per-library metadata files. Optional:
 * a single metadata file without a manifest is the single-library mode.
 * Introduced with schema v4.2.
 */
export interface WorkspaceManifest {
  version: string;
  generatedAt: string;
  libraries: ReadonlyArray<{
    name: string;
    framework: SupportedFramework;
    /** Library root, relative to the workspace root at generation time. */
    path: string;
    importAlias: string;
    /** Metadata file path, relative to the manifest's directory. */
    metadataPath: string;
  }>;
  /** `libName -> [libNames it imports from]`. */
  crossLibraryGraph: Record<string, string[]>;
  diagnostics?: readonly AnalyzerDiagnostic[];
}

// ============================================================================
// Diagnostics (schema v3.1)
// ============================================================================

export interface AnalyzerDiagnostic {
  severity: "error" | "warn";
  /** Stable machine-readable code, e.g. 'inheritance-failed'. */
  code: string;
  component?: string;
  file?: string;
  message: string;
  stack?: string;
}

// ============================================================================
// Analyzer Interface
// ============================================================================

/** Frameworks the metadata schema can describe. Only `angular` has an analyzer today. */
export type SupportedFramework = "angular" | "react";

export interface AnalyzerOptions {
  storybookPath?: string;
  documentationPath?: string;
  outputPath?: string;
  packageName?: string;
  selectorPrefix?: string;
  importPrefix?: string;
}

export interface FrameworkAnalyzer {
  readonly framework: SupportedFramework;
  analyze(libraryPath: string, options?: AnalyzerOptions): Promise<ComponentMetadataFile>;
}
