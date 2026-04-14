# How `@cl-mcp/analyzer` Works — A Complete Walkthrough

This document explains, step by step, how the analyzer ingests an Angular component library source tree and produces `component-metadata.json` (schema v4.1 — additive bump from v4.0 adding `StorybookExample.usedComponentRefs` and optional `ContentSlotAnalysis.selectorAlternates`). It covers every configurable option, the full pipeline, each extraction stage, the semantic-relations model, and the output shape.

> Scope: the analyzer package (`packages/analyzer/`). The MCP server that consumes the JSON is out of scope.

---

## 1. High-Level Model

The analyzer is a **build-time AST pipeline**. It does not run Angular; it reads TypeScript sources with the TypeScript compiler API, combines that with pattern matching over templates, Storybook files, and JSDoc, and emits a single structured JSON file.

```
Angular lib sources (+ optional Storybook + optional docs)
        │
        ▼
  TypeScript compiler API (ts.Program + TypeChecker)
        │
        ▼
  Per-component extraction passes (AST + regex)
        │
        ▼
  Cross-component passes (import graph, co-occurrence, related)
        │
        ▼
  component-metadata.json (schema v4.1)
```

The CLI entrypoint is `src/cli/generate-metadata.ts`. The Angular AST core is `src/analyzers/angular/angular-analyzer.ts`. Everything else under `src/shared/` is support (cache, graph, validator, diagnostics, TS helpers).

---

## 2. CLI: Every Configurable Option

Command:

```bash
node packages/analyzer/dist/cli/generate-metadata.js \
  --framework angular \
  --path <library-source-path> \
  [--package <name>] \
  [--prefix <selector-prefix>] \
  [--import-prefix <subpath-prefix>] \
  [--storybook <path>] \
  [--docs <path>] \
  [--output <path>] \
  [--allow-partial]
```

| Flag | Required | Default | Purpose |
|------|----------|---------|---------|
| `--framework` | no | `"angular"` | Which framework analyzer to use. Only `angular` is implemented; anything else is rejected. |
| `--path` | **yes** | — | Absolute or relative path to the root of the component library source tree. Resolved to an absolute path. |
| `--package` | no | basename of `--path` | Package name used to synthesize the default `--import-prefix`. |
| `--prefix` | no | `""` (empty) | CSS-selector prefix filter (e.g. `mat-`). Components whose selectors do not start with this prefix, or whose selectors start with `test-` / `storybook-`, are filtered from the selector map. |
| `--import-prefix` | no | `<package>/` | Subpath import prefix used to detect **sibling component imports** when building the import graph (e.g. `@angular/material/`). |
| `--storybook` | no | unset | Path to a Storybook source tree. When provided, `StorybookExtractor` mines usage examples and powers the "often-used-with" relation. |
| `--docs` | no | unset | Path to a single markdown file. Its entire content is embedded as `libraryDocumentation` in the output. |
| `--output` | no | `./component-metadata.json` | Where to write the JSON. Resolved to an absolute path; parent directory is created. |
| `--allow-partial` | no | `false` | If set, exit code is `0` even when error-severity diagnostics were collected. Without it, any error exits `1`. |

Argument parsing is in `src/cli/generate-metadata.ts:88` (`parseArgs`). Boolean flags (only `--allow-partial`) do not consume the next token; value flags take the next token verbatim.

### 2.1 How Defaults Cascade

- `packageName` ← `--package` ?? `path.basename(libraryPath)`
- `importPrefix` ← `--import-prefix` ?? `${packageName}/`
- `selectorPrefix` ← `--prefix` ?? `""`
- `outputPath` ← `--output` ?? `./component-metadata.json`

### 2.2 What You Cannot Configure (Currently)

- **Framework**: only Angular. `FrameworkAnalyzer` (see `src/analyzers/analyzer.interface.ts`) is designed for other frameworks, but no implementations exist.
- **Component discovery rules**: hard-coded walk of the library path.
- **Selector-filter exclusions**: `test-` and `storybook-` prefix filters are hard-coded.
- **"Non-component" subpackage list** for the import graph is hard-coded: `core`, `cdk`, `theming`, `prebuilt-themes`, `schematics`, `testing` (see `src/shared/import-graph.ts:22`).
- **Semantic relations**: there are no keyword maps, synonym lists, or tunable similarity thresholds. Relatedness is computed from imports + Storybook co-occurrence only (see §7).

---

## 3. Pipeline: What Happens in Order

The `main()` function in `src/cli/generate-metadata.ts:683` orchestrates everything. Phases below match that function's structure.

### Phase 1 — Setup
1. Parse CLI args.
2. Validate `framework === "angular"`, otherwise fail.
3. Instantiate `DiagnosticsCollector` (errors/warnings aggregator).
4. Instantiate `AngularAstAnalyzer`.
5. Discover component directories under `--path`.
6. Recursively collect every `.ts` file (excluding `*.spec.*`).
7. Create `ts.Program` with ES2022 target so the `TypeChecker` is available for literal-union resolution.
8. Hand the program to the analyzer (`setTypeChecker(program)`).

### Phase 2 — Source file cache
`SourceFileCache` (`src/shared/source-file-cache.ts`) is pre-populated with every `ts.SourceFile` from the program. All downstream passes reuse these cached nodes rather than re-parsing from disk.

### Phase 3 — Library-level metadata
- If `--docs` is set and the file exists, its contents are embedded under `libraryDocumentation`.
- If `--storybook` is set and the directory exists, a `StorybookExtractor` is constructed (used per component in Phase 5).

### Phase 4 — Import graph (first cross-component pass)
`buildImportGraph()` (`src/shared/import-graph.ts:39`) walks every component directory, reads imports from each `.ts` file, and builds two indexes:

- `imports[component] = [...otherComponents]` — what this component pulls in.
- `importedBy[component] = [...otherComponents]` — reverse index.

An import counts as a sibling-component import if either:
- its module specifier starts with `--import-prefix` (e.g. `@angular/material/button`), **or**
- it is a relative path that resolves into another component directory under the library root.

### Phase 5 — Per-component analysis
For each discovered component directory, `analyzeComponent()` runs these sub-steps in order (`src/cli/generate-metadata.ts:245`):

1. **AST extraction** — `analyzer.analyzeFile()` for every non-spec `.ts`. See §4.
2. **Inheritance** — `analyzeInheritance()` per class. See §4.5.
3. **Content projection** — `analyzeContentProjection()` per file. See §4.6.
4. **Deprecation** — `extractDeprecation()` on the main component class. See §4.7.
5. **Config tokens** — `resolveConfigToken()` on files matching `-config.` or `.token.`. See §4.8.
6. **Path normalization** — absolute paths in the analysis are rewritten to relative paths before serialization.
7. **Storybook examples** — `storybookExtractor.extractStories(componentName)` if enabled. See §5.
8. **Import dependencies** — `resolveDependencies()` turns graph entries into `{ required, optional, providers }`.
9. **README** — if `README.md` exists in the component directory, its content is embedded.
10. **LLM summary** — `generateLLMSummary()` produces a short human-readable blurb (heuristic, not ML).
11. **Common patterns** — `extractCommonPatterns()` lists detected structural patterns (FormControl, content slots, etc.).

Each sub-step is guarded: failures are appended to the `DiagnosticsCollector` and do not abort the pipeline.

### Phase 6 — Related components (second cross-component pass)
1. `buildStorybookCooccurrences()` — walks every Storybook example template, records which prefixed selectors appear together, produces `Map<component, coOccurringComponents>`.
2. `findRelatedComponents()` — per component, combines import-based "requires" edges with co-occurrence-based "often-used-with" edges.

### Phase 7 — Selector map
`generateSelectorMap()` (`src/cli/generate-metadata.ts:629`) builds a flat `Record<selector, SelectorQuickInfo>` for fast lookup by the MCP server. It applies the prefix filters described in §2.

### Phase 8 — Write + exit
1. Create the output directory if missing.
2. Attach `diagnostics` array to the metadata object.
3. Write JSON.
4. Exit `1` if `collector.hasErrors()` and `--allow-partial` is not set; otherwise `0`.

---

## 4. Angular AST Core (`angular-analyzer.ts`)

### 4.1 AST walk strategy
`AngularAstAnalyzer.analyzeFile(filePath)` (`src/analyzers/angular/angular-analyzer.ts:136`):

1. Prefer the `SourceFile` from the shared `ts.Program` (needed for the `TypeChecker`).
2. If absent, fall back to a fresh `ts.createSourceFile()` parse (type-checker-dependent features will degrade gracefully).
3. Walk depth-first with `ts.forEachChild`, dispatching by node kind:
   - `ClassDeclaration` → `analyzeClass()` (routes to component/directive/service/pipe by decorator)
   - exported `InterfaceDeclaration` / `TypeAliasDeclaration` / `EnumDeclaration` / `FunctionDeclaration` → their own analyzers

The analyzer mutates a single `FileAnalysis` object during the walk and returns it.

### 4.2 Component / directive extraction
`analyzeComponentOrDirective()` handles `@Component` and `@Directive`. Per class, it extracts:

- **Decorator metadata** (`ComponentMetadata`): `selector`, inline `template` XOR `templateUrl`, `styleUrls`, `standalone`, `changeDetection`, `encapsulation`, `exportAs`, `host`, `hostDirectives`, etc. Decorator arguments are evaluated by `evaluateExpression` (`src/shared/ts-util.ts:85`) — a hardened literal evaluator (strings, numbers, booleans, arrays, plain object literals; complex expressions fall back to `.getText()`).
- **Inputs**: from `@Input()` on property declarations, getters, setters, and methods; plus signal inputs (`input()`, `input.required()`).
- **Outputs**: from `@Output()` on `EventEmitter<T>` properties and signal outputs (`output()`).
- **Public methods**: non-private, non-lifecycle methods with parameters and return type.
- **Lifecycle hooks**: matched against a hard-coded set (`ngOnInit`, `ngOnDestroy`, `ngAfterViewInit`, etc.).
- **Constructor dependencies**: parameter names, types, access modifiers, decorators (`@Inject`, `@Optional`, `@SkipSelf`, `@Self`, `@Host`).
- **JSDoc description**: the free-text block on the class.

### 4.3 Input extraction details
Each input becomes a discriminated union on `required`:

```ts
type InputProperty =
  | { required: true;  name; type; typeResolved; alias?; description?; transform?; resolvedValues }
  | { required: false; name; type; typeResolved; alias?; description?; transform?; resolvedValues; defaultValue? };
```

Rules:
- `required: true` is set **only** when the decorator options explicitly contain `required: true` (or the signal factory is `input.required()`). Type-annotation `!` alone is not enough.
- `defaultValue` is read from the initializer expression.
- `typeResolved` is `true` when the type annotation exists and was parsed verbatim; `false` when inference from initializer failed or type is unresolvable.
- Getter/setter pairs with `@Input()` on both are deduplicated — first occurrence wins, with a preference for the entry whose `typeResolved` is `true`.

### 4.4 Literal-union resolution
When an input's type is a string/number literal union (`'primary' | 'accent' | 'warn'`), the analyzer attempts to resolve it to a concrete list:

1. Requires the `TypeChecker` (i.e. the file is part of the `ts.Program`).
2. Calls `checker.getTypeFromTypeNode(typeNode)` and enumerates union members.
3. Keeps string and number literals; ignores `undefined` / `null`.
4. If any member is not a literal (e.g. a type reference), marks `resolvedValues.partial = true`.

Failures emit diagnostics:
- `union-resolution-no-checker` — analyzer has no program.
- `union-resolution-not-in-program` — the file was parsed outside the program (cache fallback).

### 4.5 Inheritance
`analyzeInheritance(className, sourceFile, cache, diagnostics)` (`src/analyzers/angular/angular-analyzer.ts:1181`):

1. Finds the class; walks `heritageClauses` for `extends`.
2. Resolves the base class's import specifier via `resolveImportPath()`:
   - Matches named imports in the current file.
   - Resolves relative paths to on-disk files.
   - Resolves subpath package imports against the library root + `--import-prefix`.
   - Follows re-exports through barrel files (`index.ts`), with `MAX_DEPTH = 10` to avoid cycles.
3. Re-analyzes the base class's source file (via cache) and harvests its inputs/outputs.
4. Also captures `implements` clauses as `mixins: string[]`.

Output is stored under `inheritance[ClassName] = { baseClass, baseClassPath, inheritedInputs, inheritedOutputs, mixins }`. A top-level `inheritanceResolved: boolean` is set to `false` if any import could not be resolved (produces diagnostic `inheritance-unresolved-import`).

### 4.6 Content projection (ng-content)
`analyzeContentProjection()` reads the template (inline string or `templateUrl` from disk) and parses it with `@angular/compiler`'s `parseTemplate` via the shared wrapper in `src/shared/template-parser.ts`. A per-run `TemplateParseCache` (keyed by `sha1(template)+sourceUrl`) guarantees each unique template is parsed exactly once across all three template-consuming call-sites (content projection, template validator, storybook used-component extraction).

The walker descends every Angular 17+ control-flow block (`@if`/`@for`/`@switch`/`@defer`) plus legacy `*ngIf`/`*ngFor` wrappers, so `<ng-content>` nodes nested inside control-flow are honored — unlike the previous regex scan.

For each `<ng-content>` slot:
- `name` = `ngProjectAs` value if present, else the `select` attribute value, else `"default"`.
- `selector` = the `select` value (undefined for the default slot).
- `required` = `true` when the `required` attribute is present on the node (honest: the regex implementation always reported `false`).
- `multiple: !selector` — an unselected slot accepts any content.
- `selectorAlternates?` (v4.1, optional) — populated for compound selectors like `select="[foo], [bar]"` with the comma-split list.

Duplicate slots are deduped by primary `selector` string. Commented-out `<!-- <ng-content /> -->` are correctly ignored (the regex mis-counted them).

On parse failure with no recovered nodes, a `template-parse-failed` warn-severity diagnostic is emitted and an empty slot list is returned. When the parser reports errors but still produces nodes, the diagnostic is emitted and the walker proceeds over the recovered tree (soft failure). The existing `MAX_TEMPLATE_LENGTH` (100 KB) guard in the validator short-circuits before the parser; `analyzeContentProjection` relies on library-source templates being well below that bound.

### 4.7 Deprecation
`extractDeprecation()` reads `@deprecated` from:
1. JSDoc tags via `ts.getJSDocTags()`, **or**
2. Raw leading comment text (fallback for non-JSDoc-style comments).

The comment text is mined for four pieces with regex heuristics:
- `since` — `/since\s+v?(\d+\.\d+\.\d+)/i`
- `removeIn` — `/(?:removed?\s+in|remove\s+(?:in|at))\s+v?(\d+\.\d+\.\d+)/i`
- `replacement` — `/(?:use|replaced?\s+(?:by|with))\s+(\S+)\s+instead/i`
- `reason` — full raw comment text

Missing fields are simply omitted.

### 4.8 Config tokens
`resolveConfigToken()` targets Angular's common config pattern:

```ts
export interface MatFooConfig { ... }
export const MAT_FOO_DEFAULT_OPTIONS = new InjectionToken<MatFooConfig>('...');
export const DEFAULT_MAT_FOO_CONFIG: MatFooConfig = { ... };
```

Algorithm:
1. Collect every interface in the file → `TypeMember[]` with `{ name, type, optional, jsDoc }`.
2. Collect every `new InjectionToken<T>(...)` binding and every `DEFAULT_*_CONFIG` / `*_DEFAULT_CONFIG` const.
3. Pair each token with the interface named in its type argument; pair with the default-values const by naming convention.

Only files matching `*-config.*` or `*.token.*` are scanned (from `src/cli/generate-metadata.ts:357`).

---

## 5. Storybook Extractor

`StorybookExtractor.extractStories(componentName)` (`src/analyzers/angular/storybook-extractor.ts:57`):

1. Resolves the component's stories directory under `<storybook>/src/lib/<componentName>` (with singular/plural and dash-stripped variants).
2. **Wrapper stories**: parses every `*.story.ts` file — these are `@Component` wrapper classes whose `template` embeds real usage. Templates are sanitized (custom `sbFs*` attributes stripped), then parsed with the shared `TemplateParseCache` (v4.1) to walk every `TmplAstElement` (tag names) and its attributes (potential attribute-directive selectors). Only prefix-matching element tags flow into `usedComponents`; the full raw token set (`{ elements, attributes }`) is parked in `StorybookExtractor.rawTemplateTokens` for the CLI post-pass. A regex-based fallback still runs when the parser is unavailable (e.g. older test harnesses that instantiate the extractor without a cache).
3. **Main stories file**: parses the `*.stories.ts` file for the CSF `meta` default export and each named story export, harvesting `args`, `argTypes`, and — if present — the `render: (args) => ({ template })` template.
4. Matches story metadata to wrapper examples by normalized story name; unmatched stories become standalone examples.

Output per example:

```ts
{ storyName, filePath, template, args, argTypes?, usedComponents, usedComponentRefs? }
```

- `usedComponents: string[]` — flat list of library selectors referenced by the story (back-compat). As of v4.1 this includes **attribute-directive selectors** (e.g. `matTooltip`, `cdkDrag`) resolved against the library's selector map in a CLI post-pass, not just element tags.
- `usedComponentRefs?: { selector, kind: 'element' | 'attribute' }[]` — v4.1 additive field that preserves the element-vs-attribute distinction. `often-used-with` edge weighting is blind to `kind`, but downstream consumers (MCP server, docs tooling) can use it.

The CLI phase order is: per-component analysis → selector-map generation → storybook-token resolution pass → co-occurrence build → related-components. Token resolution runs against the full selector map, so attribute directives defined anywhere in the library correctly resolve even when their host story lives in a different component's directory.

### 5.1 Post-pass: attribute-directive resolution

Attribute-directive selectors (e.g. `matTooltip`, `cdkDrag`) cannot be identified during per-component analysis — they require the complete library selector map, which does not exist until every component has been analyzed. Consider a story template like:

```html
<button mat-button matTooltip="Save" cdkDrag>Save</button>
```

The parser sees one element (`<button>`) and four attribute tokens (`mat-button`, `matTooltip`, `cdkDrag`, plus the literal `Save`). Nothing in the parse output tells the extractor which attributes are library selectors and which are plain HTML. Resolving this requires a library-wide reverse lookup.

The pipeline handles it in three steps:

1. **Collect raw tokens** — During Storybook extraction, `StorybookExtractor` walks every template with the shared `TemplateParseCache` and records `{ elements, attributes }` per example in `rawTemplateTokens: Map<StorybookExample, RawTemplateTokens>` (`src/analyzers/angular/storybook-extractor.ts:70`). At this stage `usedComponents` is only seeded with element tags matching the configured selector prefix; attributes are parked unresolved.
2. **Build the selector map** — After every component is analyzed, `generateSelectorMap()` (`src/cli/generate-metadata.ts:629`) produces the complete `Record<selector, SelectorQuickInfo>` for the whole library.
3. **Resolve tokens against the map** — `resolveStorybookUsedComponents(examples, selectorMap, rawTokens)` (`src/cli/generate-metadata.ts:713`, invoked in the orchestrator right after selector-map generation) iterates each example's raw attribute tokens and looks them up in the selector map. Matches are appended to `usedComponents` (flat, back-compat) and to `usedComponentRefs` with `kind: "attribute"`. Element-tag matches are recorded with `kind: "element"`. Compound selectors (`select="[foo], [bar]"`) are comma-split before lookup so each alternate resolves independently.

Only after this post-pass can `buildStorybookCooccurrences()` and `findRelatedComponents()` produce correct edges — run earlier, they would silently miss every directive-based relationship (roughly 10× fewer edges on Angular-Material-class libraries). This is why the phase order in §3 places selector-map generation **before** co-occurrence, rather than alongside per-component writes.

---

## 6. Template Validation (`template-validator.ts`)

This is a separate capability (exposed to the MCP server, not part of metadata generation). Given a template string and the registered component APIs, it:

1. Parses the template with `@angular/compiler.parseTemplate` (via the shared `TemplateParseCache`) and walks the R3 AST to collect per-element bindings: `[input]`, `[(twoWay)]` (deduped against its synthesized `Change` event), `(output)`, `TextAttribute`s, and attribute-directive selector candidates. Angular 17+ control-flow (`@if` / `@for` / `@switch` / `@defer`) and legacy structural directives (`*ngIf` / `*ngFor`, surfaced as `TmplAstTemplate` hosts) are descended.
2. Checks each binding against the component's inputs/outputs and the registered directive inputs/outputs. Every diagnostic carries an optional `sourceSpan: { line, column, length }` derived from the parser.
3. Produces fuzzy-match suggestions using **Levenshtein distance ≤ 3**.
4. Enforces required inputs.
5. Ignores a hard-coded allowlist of common HTML attributes (`class`, `id`, `style`, `href`, …), Angular directives (`ngIf`, `ngFor`, `formControl`, …), and built-in pipes (`async`, `date`, `currency`, …).
6. Walks every `BindingPipe` node in every attached `ASTWithSource` expression (interpolations, bound attributes, bound-text children) and checks built-in pipes against an arity table (e.g. `slice` takes 1–2 args, `json` takes 0).

It guards against pathological inputs (> 100 KB templates are short-circuited upfront via the `MAX_TEMPLATE_LENGTH` constant). On parser failure with no recovered nodes, returns a single `template-parse-failed` warning and emits a matching diagnostic; on partial recovery, emits the diagnostic and validates against the recovered tree.

---

## 7. Semantic Relations — The Truth

A common misconception: the analyzer has a taxonomy of semantic relationships between components. **It does not.** There are no keyword maps, synonym lists, ontologies, embeddings, or tunable thresholds. All relatedness is derived from two structural signals:

### 7.1 `requires` — from imports
If component A imports component B (either via `--import-prefix` subpath import or a relative path that resolves into B's directory), an edge `A requires B` is emitted, with a `reason` string like `"imported directly"`. The `NON_COMPONENT_SUBPACKAGES` allowlist suppresses internal subpackages (`core`, `cdk`, `theming`, `prebuilt-themes`, `schematics`, `testing`) so they never surface as "related".

### 7.2 `often-used-with` — from Storybook co-occurrence
Two components that appear in the same Storybook story template co-occur. The co-occurrence map is built once (Phase 6), then turned into `often-used-with` edges with a `reason` like `"appears together in N Storybook example(s)"`.

As of v4.1 **attribute directives contribute co-occurrence edges on equal footing with element components**. A story template like `<button mat-button matTooltip="hi">Save</button>` now emits three edges (`mat-button`, `matTooltip`, and — if the story belongs to e.g. `mat-dialog` — the host component) rather than zero. This typically produces ~10× more edges on Angular-Material-class libraries than the pre-v4.1 regex implementation, which only saw element tags.

### 7.3 `alternative-to` — not implemented
The `RelatedComponent` union includes `"alternative-to"`, but nothing in the current code produces edges of this kind. It is reserved for future use.

### 7.4 Other structural heuristics
These are *not* semantic relations but are worth knowing, because they shape the output:

- **Selector-map prefix filter** (`--prefix`): selectors not matching the prefix — or starting with `test-` / `storybook-` — are excluded from `selectorMap`.
- **FormControl detection**: exact-name check for inputs `formControl` or `formControlName`. No fuzzy match.
- **LLM summary**: counts of inputs/outputs/directives/pipes, base class names, content slots, config tokens. Pure structural synthesis.

---

## 8. Diagnostics

Every extraction pass collects non-fatal issues into `DiagnosticsCollector` (`src/shared/diagnostics.ts`). Each entry carries `{ severity, code, component?, file?, message, stack? }`.

Codes you will see:

| Code | Meaning |
|------|---------|
| `inheritance-failed` | The inheritance pass threw. |
| `inheritance-unresolved-import` | Base class import could not be resolved. |
| `content-projection-failed` | ng-content parsing threw. |
| `deprecation-failed` | JSDoc deprecation extraction threw. |
| `config-token-failed` | InjectionToken resolution threw. |
| `storybook-failed` | Story extraction threw. |
| `component-analysis-failed` | Top-level per-component analysis threw. |
| `union-resolution-no-checker` | Literal-union resolution ran without a `TypeChecker`. |
| `union-resolution-not-in-program` | The source file was parsed outside the `ts.Program`. |
| `anonymous-class-skipped` | Component/directive/pipe/service without a class name. |
| `empty-selector` | Component/directive declared with no selector. |
| `duplicate-selector` | Two components declare the same selector. |
| `template-parse-failed` | `@angular/compiler.parseTemplate` reported errors on a template (content projection, template validator, or storybook extraction). Always `severity: "warn"` — never gates CI. When no nodes could be recovered, downstream extraction falls back to an empty result; when nodes are partially recovered, the walker still runs over them. |

Exit behavior:
- Any `severity: "error"` → exit `1`, unless `--allow-partial` is set.
- `severity: "warn"` → never changes exit code.
- The full diagnostics array is written into the JSON, so the MCP server/LLM can reason about gaps.

---

## 9. Output Shape (schema v4.1)

Top level:

```ts
interface ComponentMetadataFile {
  version: "4.1.0";
  generatedAt: string;                 // ISO timestamp
  componentsPath: string;              // relative to cwd at generation time
  importPrefix?: string;
  libraryDocumentation?: string;       // full text of --docs file
  components: Record<string, AnalyzedComponentEntry>;
  selectorMap?: Record<string, SelectorQuickInfo>;
  diagnostics?: readonly AnalyzerDiagnostic[];
}
```

Per component:

```ts
interface AnalyzedComponentEntry {
  kind: "analyzed" | "skipped" | "failed";
  name: string;
  exports: string[];                   // symbols exported from the component's index.ts
  files: string[];                     // relative paths
  readme?: string;
  analysis: FileAnalysis[];            // per-file AST analysis

  dependencies: {
    required: string[];                // currently always []
    optional: string[];                // from the import graph
    providers: { required: []; optional: []; };  // currently always []
  };

  examples: { name; description; template?; typescript?; scss? }[];  // currently empty; Storybook examples live under storybookExamples

  // Enhancement fields
  inheritance?: Record<string, InheritanceInfo>;
  contentProjection?: ContentSlotInfo[];
  deprecation?: DeprecationInfo;
  configTokens?: ConfigTokenInfo[];
  storybookExamples?: StorybookExample[];
  importsFrom?: string[];
  relatedComponents?: RelatedComponent[];
  llmSummary?: string;
  commonPatterns?: string[];
  inheritanceResolved: boolean;
}
```

Per file (`FileAnalysis`) contains `components[]`, `directives[]`, `pipes[]`, `services[]`, `exportedTypes[]`, `exportedFunctions[]`.

Per component class (`ComponentAnalysis`) contains `className`, `filePath`, `metadata`, `inputs[]`, `outputs[]`, `publicMethods[]`, `dependencies[]`, `lifecycleHooks[]`, `exportedTypes[]`, `jsDocDescription?`.

`SelectorQuickInfo` is the compact lookup for the MCP server:

```ts
interface SelectorQuickInfo {
  component: string;
  type?: "component" | "directive";
  mainInputs: string[];        // up to 5; required inputs get a leading '*'
  mainOutputs: string[];       // up to 3
  formControl?: boolean;
  hasContentSlots?: boolean;
  deprecated?: boolean;
  configRequired?: string[];
}
```

Types are branded (`FilePath`, `ClassName`, `Selector`) to prevent cross-mixing in consumers (`src/types.ts`).

---

## 10. Framework Abstraction

`src/analyzers/analyzer.interface.ts` declares:

```ts
interface FrameworkAnalyzer {
  readonly framework: "angular";
  analyze(libraryPath: string, options: AnalyzerOptions): Promise<ComponentMetadataFile>;
}
```

This is the seam for future framework support. The current Angular pipeline is orchestrated directly in the CLI and does **not** implement this interface — it uses `AngularAstAnalyzer` as a low-level helper and stitches the stages itself. Adding React/Vue would mean implementing `FrameworkAnalyzer` for real and having the CLI dispatch by `--framework`.

---

## 11. Quick Reference — File → Responsibility

| File | Responsibility |
|------|----------------|
| `src/cli/generate-metadata.ts` | CLI parsing, pipeline orchestration, selector map, LLM summary, exit policy |
| `src/analyzers/angular/angular-analyzer.ts` | Core Angular AST extraction + inheritance / content-projection / deprecation / config-token helpers |
| `src/analyzers/angular/storybook-extractor.ts` | Parse `*.story.ts` wrappers and `*.stories.ts` CSF metadata |
| `src/shared/import-graph.ts` | Import graph, Storybook co-occurrence, `relatedComponents` |
| `src/shared/template-validator.ts` | Template validation for MCP `validate_template` tool |
| `src/shared/diagnostics.ts` | `DiagnosticsCollector` |
| `src/shared/source-file-cache.ts` | Shared `ts.SourceFile` cache |
| `src/shared/ts-util.ts` | Decorator-name, JSDoc, literal-eval, type-arg helpers |
| `src/types.ts` | Canonical metadata schema v4.1 (shared with the MCP server) |
| `src/shared/template-parser.ts` | `@angular/compiler.parseTemplate` wrapper, `TemplateParseCache`, and `walkTemplate` visitor used by all three template-consuming call-sites |
| `src/analyzers/analyzer.interface.ts` | Framework-agnostic analyzer interface (seam for future frameworks) |

---

## 12. Mental Model — Short Version

1. Parse a library with the TS compiler API.
2. For every component class: decorator metadata + inputs + outputs + methods + deps + lifecycle.
3. Enhance each component with: inheritance, content slots, deprecation, config tokens, Storybook examples.
4. Cross-component: import graph → `requires`; Storybook co-occurrence → `often-used-with`.
5. Flatten to a selector map for fast MCP lookup.
6. Write JSON. Diagnostics travel with the output. Non-zero exit on errors unless `--allow-partial`.

No magic, no ML, no keyword ontologies — structural signals only, deliberately conservative.

---

## 13. End-to-End Examples

This section walks concrete inputs (Angular source) through the pipeline to concrete outputs (fragments of `component-metadata.json`). Every output snippet is shaped exactly as the analyzer emits it; fields not relevant to the example are elided with `/* … */`.

### 13.1 The full pipeline, one command

Say you have Angular Material checked out at `/tmp/material/src/material` and Storybook stories at `/tmp/material-storybook/src`. The canonical invocation is:

```bash
node packages/analyzer/dist/cli/generate-metadata.js \
  --framework angular \
  --path /tmp/material/src/material \
  --package @angular/material \
  --prefix mat- \
  --import-prefix @angular/material/ \
  --storybook /tmp/material-storybook \
  --docs /tmp/material/README.md \
  --output ./data/angular-material/component-metadata.json
```

What happens:

1. Discovers every component directory under `--path` (e.g. `button/`, `dialog/`, `form-field/`).
2. Builds one `ts.Program` covering all non-spec `.ts` files so the `TypeChecker` can resolve literal unions across files.
3. For each component: runs the 11 sub-steps from §3 Phase 5.
4. Builds the import graph, resolves Storybook tokens against the finished selector map, then computes `relatedComponents`.
5. Writes JSON; exits `0` (or `1` on error unless `--allow-partial`).

The rest of this section shows what individual pieces of that output look like.

### 13.2 A minimal component

**Input** — `button/button.component.ts`:

```ts
import { Component, Input, Output, EventEmitter } from "@angular/core";

/** A styled push-button. */
@Component({
  selector: "mat-button",
  standalone: true,
  template: `<button (click)="pressed.emit()"><ng-content /></button>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatButton {
  /** Visual variant. */
  @Input() variant: "primary" | "accent" | "warn" = "primary";

  /** Disable the button. */
  @Input({ required: true }) disabled!: boolean;

  /** Emitted on click. */
  @Output() pressed = new EventEmitter<void>();
}
```

**Output** — entry under `components["button"]` (elided):

```json
{
  "kind": "analyzed",
  "name": "button",
  "analysis": [{
    "filePath": "button/button.component.ts",
    "components": [{
      "className": "MatButton",
      "jsDocDescription": "A styled push-button.",
      "metadata": {
        "selector": "mat-button",
        "standalone": true,
        "changeDetection": "OnPush",
        "template": "<button (click)=\"pressed.emit()\"><ng-content /></button>"
      },
      "inputs": [
        {
          "name": "variant",
          "type": "'primary' | 'accent' | 'warn'",
          "typeResolved": true,
          "required": false,
          "defaultValue": "'primary'",
          "description": "Visual variant.",
          "resolvedValues": { "values": ["primary", "accent", "warn"], "partial": false }
        },
        {
          "name": "disabled",
          "type": "boolean",
          "typeResolved": true,
          "required": true,
          "description": "Disable the button."
        }
      ],
      "outputs": [
        { "name": "pressed", "type": "void", "typeResolved": true, "description": "Emitted on click." }
      ],
      "lifecycleHooks": [],
      "publicMethods": [],
      "dependencies": []
    }],
    "directives": [], "pipes": [], "services": [],
    "exportedTypes": [], "exportedFunctions": []
  }],
  "contentProjection": [
    { "name": "default", "multiple": true, "required": false }
  ],
  "inheritanceResolved": true,
  "dependencies": { "required": [], "optional": [], "providers": { "required": [], "optional": [] } }
}
```

Key things to notice:
- `required: true` on `disabled` is set **only** because the decorator options said so; the `!` alone would not flip it (see §4.3).
- `resolvedValues.values` came from the `TypeChecker` enumerating the literal union (§4.4). If the file had been outside the `ts.Program`, you would see a `union-resolution-not-in-program` diagnostic and `resolvedValues: null`.
- The default `<ng-content />` becomes a single `{ name: "default", multiple: true }` slot (§4.6).
- `jsDocDescription` is the `/** A styled push-button. */` block above the class.

### 13.3 Signal inputs & content slots with selectors

**Input** — `card/card.component.ts`:

```ts
import { Component, input, output } from "@angular/core";

@Component({
  selector: "mat-card",
  standalone: true,
  template: `
    <header><ng-content select="[cardTitle]" /></header>
    <section><ng-content /></section>
    <footer><ng-content select="mat-card-actions, [cardFooter]" /></footer>
  `,
})
export class MatCard {
  elevation = input<number>(1);
  appearance = input.required<"raised" | "outlined">();
  click = output<MouseEvent>();
}
```

**Output** fragments:

```json
"inputs": [
  { "name": "elevation", "type": "number", "typeResolved": true, "required": false, "defaultValue": "1" },
  { "name": "appearance", "type": "'raised' | 'outlined'", "typeResolved": true, "required": true,
    "resolvedValues": { "values": ["raised", "outlined"], "partial": false } }
],
"outputs": [
  { "name": "click", "type": "MouseEvent", "typeResolved": true }
],
"contentProjection": [
  { "name": "cardTitle",  "selector": "[cardTitle]", "required": false, "multiple": false },
  { "name": "default",    "required": false, "multiple": true },
  { "name": "cardFooter", "selector": "mat-card-actions, [cardFooter]", "required": false, "multiple": false,
    "selectorAlternates": ["mat-card-actions", "[cardFooter]"] }
]
```

The compound `select="mat-card-actions, [cardFooter]"` triggers the v4.1 `selectorAlternates` field (§4.6) — every comma-split alternate is preserved so downstream tools can resolve each one against the selector map.

### 13.4 Inheritance across packages

**Input** — `_base/focusable.ts`:

```ts
export abstract class Focusable {
  @Input() tabIndex: number = 0;
  @Output() focused = new EventEmitter<void>();
}
```

**Input** — `button/icon-button.component.ts`:

```ts
import { Focusable } from "../_base/focusable";

@Component({ selector: "mat-icon-button", standalone: true, template: "..." })
export class MatIconButton extends Focusable implements OnInit {
  @Input() icon!: string;
  ngOnInit() {}
}
```

**Output** — the `inheritance` map under `components["button"]`:

```json
"inheritance": {
  "MatIconButton": {
    "baseClass": "Focusable",
    "baseClassPath": "_base/focusable.ts",
    "inheritedInputs":  [{ "name": "tabIndex", "type": "number", "typeResolved": true, "defaultValue": "0", "required": false }],
    "inheritedOutputs": [{ "name": "focused",  "type": "void",   "typeResolved": true }],
    "mixins": ["OnInit"]
  }
},
"inheritanceResolved": true
```

The resolver (§4.5) followed the relative import, cached the base source file, and harvested its `@Input`/`@Output` declarations. `implements OnInit` is captured separately in `mixins`. If the import had been unresolvable (e.g. a subpath alias not configured), you would see `inheritanceResolved: false` plus a diagnostic:

```json
{ "severity": "error", "code": "inheritance-unresolved-import",
  "component": "button", "file": "button/icon-button.component.ts",
  "message": "Could not resolve base class 'Focusable' from '../_base/focusable'" }
```

### 13.5 Deprecation

**Input**:

```ts
/**
 * @deprecated since v15.2.0. Use mat-button instead. Removed in v18.0.0.
 *   The flat variant was merged into the main button API.
 */
@Component({ selector: "mat-flat-button", /* … */ })
export class MatFlatButton {}
```

**Output**:

```json
"deprecation": {
  "since": "15.2.0",
  "removeIn": "18.0.0",
  "replacement": "mat-button",
  "reason": "since v15.2.0. Use mat-button instead. Removed in v18.0.0.\n  The flat variant was merged into the main button API."
}
```

All four fields come from regex heuristics over the raw comment (§4.7). If the comment only said `@deprecated`, you would get `"deprecation": { "reason": "" }` — every field except `reason` is optional.

### 13.6 Config tokens

**Input** — `dialog/dialog-config.ts`:

```ts
import { InjectionToken } from "@angular/core";

/** Options for MatDialog. */
export interface MatDialogConfig {
  /** Whether clicking the backdrop closes the dialog. */
  disableClose?: boolean;
  /** Initial width, CSS length. */
  width?: string;
}

export const MAT_DIALOG_DEFAULT_OPTIONS = new InjectionToken<MatDialogConfig>("MAT_DIALOG_DEFAULT_OPTIONS");
export const DEFAULT_MAT_DIALOG_CONFIG: MatDialogConfig = { disableClose: false, width: "80vw" };
```

**Output**:

```json
"configTokens": [{
  "tokenName": "MAT_DIALOG_DEFAULT_OPTIONS",
  "configInterface": "MatDialogConfig",
  "defaultsConst": "DEFAULT_MAT_DIALOG_CONFIG",
  "members": [
    { "name": "disableClose", "type": "boolean", "optional": true, "jsDoc": "Whether clicking the backdrop closes the dialog." },
    { "name": "width",        "type": "string",  "optional": true, "jsDoc": "Initial width, CSS length." }
  ]
}]
```

Only files matching `*-config.*` or `*.token.*` are scanned (§4.8). The token, interface, and defaults const are paired by naming convention.

### 13.7 Storybook examples + attribute-directive resolution

**Input** — `button/button.stories.ts`:

```ts
export default { title: "Button", component: MatButton };
export const WithTooltip = { args: { variant: "primary" },
  render: (args) => ({ template: `<button mat-button matTooltip="Save" [disabled]="false">Save</button>`, props: args })
};
```

**Output** — entry under `components["button"].storybookExamples`:

```json
[{
  "storyName": "WithTooltip",
  "filePath": "button/button.stories.ts",
  "template": "<button mat-button matTooltip=\"Save\" [disabled]=\"false\">Save</button>",
  "args": { "variant": "primary" },
  "usedComponents": ["mat-button", "matTooltip"],
  "usedComponentRefs": [
    { "selector": "mat-button",  "kind": "attribute" },
    { "selector": "matTooltip",  "kind": "attribute" }
  ]
}]
```

Critically, `matTooltip` is **not** an element — it's an attribute. The extractor parks it in `rawTemplateTokens` during per-component analysis because the tooltip directive may be defined in an entirely different component directory. Only after the selector map is built does `resolveStorybookUsedComponents` look it up and attach it with `kind: "attribute"` (§5.1). Without this post-pass the tooltip edge would vanish.

### 13.8 Related components

Given:
- `button/button.component.ts` imports `ripple/ripple.directive.ts` (relative path).
- Three Storybook stories put `<mat-button>` and `<mat-icon>` together.
- Two stories put `<mat-button>` with `matTooltip` (a directive under `tooltip/`).

**Output** — under `components["button"].relatedComponents`:

```json
[
  { "name": "ripple",  "relation": "requires",         "reason": "imported directly" },
  { "name": "icon",    "relation": "often-used-with",  "reason": "appears together in 3 Storybook example(s)" },
  { "name": "tooltip", "relation": "often-used-with",  "reason": "appears together in 2 Storybook example(s)" }
]
```

There is no semantic similarity scoring — these edges are pure structural signals (§7): import graph + Storybook co-occurrence. `alternative-to` is reserved in the type union but no code currently produces it.

### 13.9 Selector map

After all per-component analysis completes, `generateSelectorMap()` flattens everything into a lookup table keyed by selector. With `--prefix mat-`:

```json
"selectorMap": {
  "mat-button": {
    "component": "button",
    "type": "component",
    "mainInputs": ["*disabled", "variant"],
    "mainOutputs": ["pressed"],
    "hasContentSlots": true
  },
  "mat-card": {
    "component": "card",
    "type": "component",
    "mainInputs": ["*appearance", "elevation"],
    "mainOutputs": ["click"],
    "hasContentSlots": true
  },
  "mat-flat-button": {
    "component": "button",
    "type": "component",
    "mainInputs": [],
    "mainOutputs": [],
    "deprecated": true
  }
}
```

Selectors not starting with `mat-`, or starting with `test-` / `storybook-`, are dropped. Required inputs get a leading `*` (`*disabled`). `hasContentSlots` is `true` whenever the component has any `contentProjection` entries. The MCP server uses this map as its primary lookup index.

### 13.10 Diagnostics

A realistic diagnostics array embedded in the output:

```json
"diagnostics": [
  { "severity": "warn",  "code": "union-resolution-not-in-program",
    "component": "legacy-toggle", "file": "legacy-toggle/legacy-toggle.component.ts",
    "message": "Literal union for input 'mode' could not be resolved: source file not in ts.Program." },
  { "severity": "warn",  "code": "template-parse-failed",
    "component": "chip", "file": "chip/chip.stories.ts",
    "message": "@angular/compiler.parseTemplate reported 1 error; recovered 3 nodes." },
  { "severity": "error", "code": "inheritance-unresolved-import",
    "component": "autocomplete", "file": "autocomplete/autocomplete.component.ts",
    "message": "Could not resolve base class 'Overlay' from '@cdk/overlay-legacy'" }
]
```

Behavior (§8):
- The two `warn` entries do **not** affect the exit code.
- The single `error` causes the CLI to exit `1` — unless you passed `--allow-partial`, in which case it still exits `0` and consumers are expected to read `diagnostics` and decide.

### 13.11 Template validation (MCP-side, not part of generation)

Though `template-validator.ts` is invoked by the MCP server rather than during metadata generation, here is what it does given the already-generated metadata above.

**Input template** (from an LLM trying to use your library):

```html
<mat-button [disabld]="true" (clickd)="go()">Save</mat-button>
```

**Output diagnostics** (returned by the `validate_template` MCP tool):

```json
[
  { "severity": "error", "code": "unknown-input",  "selector": "mat-button",
    "binding": "disabld", "message": "Unknown input 'disabld' on <mat-button>. Did you mean 'disabled'?",
    "suggestion": "disabled", "sourceSpan": { "line": 0, "column": 12, "length": 7 } },
  { "severity": "error", "code": "unknown-output", "selector": "mat-button",
    "binding": "clickd",  "message": "Unknown output '(clickd)' on <mat-button>. Did you mean 'pressed'?",
    "suggestion": "pressed", "sourceSpan": { "line": 0, "column": 28, "length": 6 } },
  { "severity": "error", "code": "missing-required-input", "selector": "mat-button",
    "message": "Required input 'disabled' is not bound on <mat-button>." }
]
```

Fuzzy suggestions come from a Levenshtein-≤ 3 search over the component's declared inputs/outputs (§6). Common HTML attributes (`class`, `id`, `style`, …) and built-in Angular directives are allowlisted so they never fire an "unknown" diagnostic.

### 13.12 End-user journey (why this exists)

To tie it together, here is the chain of causality from an LLM prompt to a correct code snippet:

1. User asks the LLM: *"Show me a Material card with a header and actions footer."*
2. MCP client calls `get_component("card")` → server reads `components["card"]` from the pre-generated JSON (§13.3 above).
3. LLM sees the `contentProjection` slots (`cardTitle`, `default`, `cardFooter` with `selectorAlternates`), the required `appearance` input, and the `elevation` default.
4. LLM drafts:
   ```html
   <mat-card appearance="raised">
     <span cardTitle>Report</span>
     <p>Summary…</p>
     <mat-card-actions><button mat-button>OK</button></mat-card-actions>
   </mat-card>
   ```
5. Client optionally calls `validate_template` (§13.11) before returning the snippet — catches hallucinated inputs/outputs *before* they reach the user.

No runtime Angular, no fuzzy "it's probably this" — every claim the LLM makes is grounded in a structural fact the analyzer extracted at build time.
