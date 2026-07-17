/**
 * Zod schema for `component-metadata.json`.
 *
 * This is the trust-boundary validator for metadata loaded at MCP-server
 * startup. The analyzer produces the file at build time; by the time the
 * server reads it, it might be stale, hand-edited, from a different major
 * version, or corrupt. Parsing through this schema — instead of casting —
 * catches shape drift loudly and immediately.
 *
 * Phase 7 (v4.0 BREAKING): discriminated unions mirror the TS types in
 * `analyzer/src/types.ts`. Illegal states (e.g. `required: true` with a
 * `defaultValue`, both `template` + `templateUrl` set, `self + skipSelf`)
 * are rejected at parse time. `importedBy` is computed at load time and
 * is no longer part of the on-disk schema.
 */

import { z } from 'zod';
import type { ComponentMetadataFile } from '../types.js';

// ── Leaves ──────────────────────────────────────────────────────────

const ResolvedValuesSchema = z.object({
  values: z.array(z.string()),
  partial: z.boolean(),
});

// InputProperty — discriminated on `required`. A required input cannot
// carry a `defaultValue`.
const InputPropertySchema = z.discriminatedUnion('required', [
  z
    .object({
      required: z.literal(true),
      name: z.string(),
      type: z.string().nullable(),
      typeResolved: z.boolean(),
      alias: z.string().optional(),
      description: z.string().optional(),
      transform: z.string().optional(),
      resolvedValues: ResolvedValuesSchema.nullable(),
    })
    // Strict: required inputs cannot carry `defaultValue`. Extra unknown
    // fields would otherwise be silently accepted by Zod's default mode.
    .strict(),
  z.object({
    required: z.literal(false),
    name: z.string(),
    type: z.string().nullable(),
    typeResolved: z.boolean(),
    defaultValue: z.string().optional(),
    alias: z.string().optional(),
    description: z.string().optional(),
    transform: z.string().optional(),
    resolvedValues: ResolvedValuesSchema.nullable(),
  }),
]);

const OutputPropertySchema = z.object({
  name: z.string(),
  eventType: z.string().nullable(),
  eventTypeResolved: z.boolean(),
  alias: z.string().optional(),
  description: z.string().optional(),
});

const MethodParameterSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  typeResolved: z.boolean(),
  optional: z.boolean(),
  defaultValue: z.string().optional(),
});

const PublicMethodSchema = z.object({
  name: z.string(),
  parameters: z.array(MethodParameterSchema),
  returnType: z.string().nullable(),
  returnTypeResolved: z.boolean(),
  description: z.string().optional(),
  isAsync: z.boolean(),
});

// InjectedDependency — `self: true` forces `skipSelf: false`.
const InjectedDependencyBaseFields = {
  name: z.string(),
  type: z.string().nullable(),
  typeResolved: z.boolean(),
  injectionToken: z.string().optional(),
  optional: z.boolean(),
  host: z.boolean(),
};
const InjectedDependencySchema = z.discriminatedUnion('self', [
  z.object({
    ...InjectedDependencyBaseFields,
    self: z.literal(true),
    skipSelf: z.literal(false),
  }),
  z.object({
    ...InjectedDependencyBaseFields,
    self: z.literal(false),
    skipSelf: z.boolean(),
  }),
]);

const TypeMemberSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  typeResolved: z.boolean(),
  optional: z.boolean(),
  description: z.string().optional(),
});

const EnumMemberSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
});

// ExportedType — discriminated on `kind`. `interface` / `class` carry
// TypeMember[]; `enum` carries EnumMember[]; `type` carries no members.
const ExportedTypeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interface'),
    name: z.string(),
    definition: z.string(),
    members: z.array(TypeMemberSchema).optional(),
  }),
  z.object({
    kind: z.literal('class'),
    name: z.string(),
    definition: z.string(),
    members: z.array(TypeMemberSchema).optional(),
  }),
  z.object({
    kind: z.literal('type'),
    name: z.string(),
    definition: z.string(),
  }),
  z.object({
    kind: z.literal('enum'),
    name: z.string(),
    definition: z.string(),
    members: z.array(EnumMemberSchema).optional(),
  }),
]);

const LifecycleHookSchema = z.object({
  name: z.string(),
  implemented: z.boolean(),
});

// ComponentMetadata — enforce XOR on template/templateUrl via .refine().
// `z.discriminatedUnion` doesn't fit because both fields are optional
// (directives carry neither), so a plain object + refinement is the
// cleanest expression of "at most one".
const ComponentMetadataSchema = z
  .object({
    selector: z.string(),
    standalone: z.boolean(),
    changeDetection: z.enum(['OnPush', 'Default']).nullable().optional(),
    encapsulation: z.enum(['None', 'Emulated', 'ShadowDom']).nullable().optional(),
    exportAs: z.string().optional(),
    template: z.string().optional(),
    templateUrl: z.string().optional(),
    styleUrls: z.array(z.string()).optional(),
    imports: z.array(z.string()).optional(),
    providers: z.array(z.string()).optional(),
  })
  .refine((m) => !(m.template !== undefined && m.templateUrl !== undefined), {
    message: 'template and templateUrl are mutually exclusive',
    path: ['template'],
  });

const ComponentAnalysisSchema = z.object({
  className: z.string(),
  filePath: z.string(),
  metadata: ComponentMetadataSchema,
  inputs: z.array(InputPropertySchema),
  outputs: z.array(OutputPropertySchema),
  publicMethods: z.array(PublicMethodSchema),
  dependencies: z.array(InjectedDependencySchema),
  lifecycleHooks: z.array(LifecycleHookSchema),
  exportedTypes: z.array(ExportedTypeSchema),
  jsDocDescription: z.string().optional(),
});

const PipeAnalysisSchema = z.object({
  className: z.string(),
  pipeName: z.string(),
  pure: z.boolean(),
  standalone: z.boolean(),
  transformMethod: PublicMethodSchema.optional(),
});

const ServiceAnalysisSchema = z.object({
  className: z.string(),
  providedIn: z.enum(['root', 'platform', 'any']).nullable().optional(),
  dependencies: z.array(InjectedDependencySchema),
  publicMethods: z.array(PublicMethodSchema),
});

const ExportedFunctionSchema = z.object({
  name: z.string(),
  parameters: z.array(MethodParameterSchema),
  returnType: z.string().nullable(),
  returnTypeResolved: z.boolean(),
  description: z.string().optional(),
  isAsync: z.boolean(),
});

const FileAnalysisSchema = z.object({
  filePath: z.string(),
  components: z.array(ComponentAnalysisSchema),
  directives: z.array(ComponentAnalysisSchema),
  pipes: z.array(PipeAnalysisSchema),
  services: z.array(ServiceAnalysisSchema),
  exportedTypes: z.array(ExportedTypeSchema),
  exportedFunctions: z.array(ExportedFunctionSchema),
});

// ── Enhanced types ──────────────────────────────────────────────────

const InheritanceInfoSchema = z.object({
  baseClass: z.string().optional(),
  baseClassPath: z.string().optional(),
  inheritedInputs: z.array(InputPropertySchema),
  inheritedOutputs: z.array(OutputPropertySchema),
  mixins: z.array(z.string()),
});

const ContentSlotInfoSchema = z.object({
  name: z.string(),
  selector: z.string().optional(),
  required: z.boolean(),
  multiple: z.boolean(),
  // v4.1 additive — compound-selector alternates captured by analyzer
  // (e.g. `select="[foo], [bar]"`). Optional for back-compat.
  selectorAlternates: z.array(z.string()).optional(),
});

const DeprecationInfoSchema = z.object({
  deprecated: z.literal(true),
  since: z.string().optional(),
  removeIn: z.string().optional(),
  replacement: z.string().optional(),
  reason: z.string().optional(),
});

const ConfigTokenInfoSchema = z.object({
  token: z.string(),
  interface: z.string(),
  properties: z.array(TypeMemberSchema),
  defaultValues: z.record(z.unknown()).optional(),
  filePath: z.string(),
  // v4.2 additive: decorator-based global config (@WithConfig) vs InjectionToken.
  kind: z.enum(['injection-token', 'with-config']).optional(),
  configKey: z.string().optional(),
});

// StorybookExample — `validated` dropped in v4.0 (derivable from validation pass).
const StorybookExampleSchema = z.object({
  storyName: z.string(),
  filePath: z.string(),
  template: z.string(),
  args: z.record(z.unknown()),
  argTypes: z.record(z.object({ options: z.array(z.string()).optional() })).optional(),
  usedComponents: z.array(z.string()),
  // v4.1 additive — structured element/attribute refs. Optional for back-compat
  // with v4.0 files that don't carry it.
  usedComponentRefs: z
    .array(
      z.object({
        selector: z.string(),
        kind: z.enum(['element', 'attribute']),
      }),
    )
    .optional(),
});

const RelatedComponentSchema = z.object({
  name: z.string(),
  relationship: z.enum(['requires', 'often-used-with', 'alternative-to']),
  reason: z.string(),
});

const SelectorQuickInfoSchema = z.object({
  component: z.string(),
  type: z.enum(['component', 'directive']).optional(),
  mainInputs: z.array(z.string()),
  mainOutputs: z.array(z.string()),
  formControl: z.boolean().optional(),
  hasContentSlots: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  configRequired: z.array(z.string()).optional(),
});

const AnalyzerDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warn']),
  code: z.string(),
  component: z.string().optional(),
  file: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
});

// EnhancedComponentMetadataEntry — discriminated on `kind`.
// `analyzed` carries the full payload; `skipped`/`failed` carry only
// `name` + `reason`. `importedBy` is NOT in the on-disk schema — it is
// computed at load time (see data/metadata.ts).
const AnalyzedComponentEntrySchema = z.object({
  kind: z.literal('analyzed'),
  name: z.string(),
  exports: z.array(z.string()),
  files: z.array(z.string()),
  readme: z.string().optional(),
  analysis: z.array(FileAnalysisSchema),
  dependencies: z.object({
    required: z.array(z.string()),
    optional: z.array(z.string()),
    providers: z.object({
      required: z.array(z.string()),
      optional: z.array(z.string()),
    }),
  }),
  examples: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      template: z.string().optional(),
      typescript: z.string().optional(),
      scss: z.string().optional(),
    }),
  ),
  inheritance: z.record(InheritanceInfoSchema).optional(),
  contentProjection: z.array(ContentSlotInfoSchema).optional(),
  deprecation: DeprecationInfoSchema.optional(),
  configTokens: z.array(ConfigTokenInfoSchema).optional(),
  storybookExamples: z.array(StorybookExampleSchema).optional(),
  importsFrom: z.array(z.string()).optional(),
  relatedComponents: z.array(RelatedComponentSchema).optional(),
  llmSummary: z.string().optional(),
  commonPatterns: z.array(z.string()).optional(),
  inheritanceResolved: z.boolean(),
});

const SkippedComponentEntrySchema = z.object({
  kind: z.literal('skipped'),
  name: z.string(),
  reason: z.string(),
});

const FailedComponentEntrySchema = z.object({
  kind: z.literal('failed'),
  name: z.string(),
  reason: z.string(),
});

const ComponentMetadataEntrySchema = z.discriminatedUnion('kind', [
  AnalyzedComponentEntrySchema,
  SkippedComponentEntrySchema,
  FailedComponentEntrySchema,
]);

export const ComponentMetadataFileSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  // v4.2 additive: absent means "angular" (every pre-v4.2 file was Angular).
  framework: z.enum(['angular', 'react']).optional(),
  libraryName: z.string().optional(),
  componentsPath: z.string(),
  importPrefix: z.string().optional(),
  libraryDocumentation: z.string().optional(),
  components: z.record(ComponentMetadataEntrySchema),
  selectorMap: z.record(SelectorQuickInfoSchema).optional(),
  diagnostics: z.array(AnalyzerDiagnosticSchema).optional(),
});

/**
 * Parse and validate raw JSON as `ComponentMetadataFile`. Throws a single
 * descriptive `Error` when the input violates the schema — the message lists
 * every offending path + reason so operators can pinpoint drift.
 */
export function parseComponentMetadata(raw: unknown): ComponentMetadataFile {
  const result = ComponentMetadataFileSchema.safeParse(raw);
  if (result.success) {
    // Zod parse returns our structural shape; brand types are compile-time
    // only, so the cast is a pure type-level widen.
    return result.data as unknown as ComponentMetadataFile;
  }

  const issueLines = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return `  - ${path}: ${issue.message}`;
  });
  throw new Error(
    `[cl-mcp] component-metadata.json failed schema validation:\n${issueLines.join('\n')}`,
  );
}
