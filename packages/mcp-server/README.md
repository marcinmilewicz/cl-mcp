# How `@cl-mcp/mcp-server` Works — A Complete Walkthrough

This document explains, step by step, how the MCP server ingests a pre-generated `component-metadata.json`, exposes it over the Model Context Protocol (MCP) via stdio, and answers tool/resource calls from LLM clients. It covers every configurable option, the full request lifecycle, each layer of the architecture, the resolution/search strategies, and the output shape.

> Scope: the MCP server package (`packages/mcp-server/`). The analyzer that produces the JSON is out of scope (see `packages/analyzer/README.md`).

---

## 1. High-Level Model

The server is a **runtime stdio MCP server** — a thin protocol adapter over `@cl-mcp/core`, which owns the data layer (`data/`), domain layer (`domain/`), and the tool handlers (`handlers.ts`). Wherever this document references `src/data/…`, `src/domain/…`, or `src/config.ts`, those files live in `packages/core/src/` since the core extraction; the behavior described is unchanged. The server does not parse any TypeScript or Angular source. At startup it loads **every resolvable** `component-metadata.json` (produced by `@cl-mcp/analyzer`) into a library registry, validates each through a Zod schema at the trust boundary, derives a per-library `LibraryConfig`, and then answers MCP `tools/list`, `tools/call`, `resources/list`, and `resources/read` requests over `StdioServerTransport`.

### Multi-library mode (v4.2)

A single metadata file (`CL_MCP_METADATA_PATH`) is the single-library mode — behavior identical to the pre-registry server. `CL_MCP_DATA_DIR` (or the `data/` convention) loads **all** `<dir>/<lib>/component-metadata.json` files. In multi-library mode:

- every tool accepts an optional `library` argument; component names accept a `lib:Name` qualifier (`ui:Button`)
- unqualified names resolve across all libraries — an unambiguous hit wins, ambiguity returns qualified suggestions
- React compound names (`Dialog.Root`) resolve in both forms — the resolver treats `.` as a strippable separator and prefers exact normalized equality over substring containment, so `DialogRoot` reaches `Dialog.Root` without colliding with `AlertDialog.Root`
- `get_library_overview` / `find_components` render one section per library when unscoped; resources are registered per library (`cl-mcp://<lib>/quick-reference`)
- the domain layer still reads a single "active" library (`src/data/registry.ts` — `withLibrary()` switches it per request; handlers are synchronous, so the switch cannot be observed mid-request)
- `validate_usage` (tool #6) dispatches by the library's framework: JSX validation for React libraries, template validation for Angular; `validate_template` refuses React libraries with a pointer
- React libraries render binding examples in JSX syntax (`variant={value}`) instead of Angular syntax

The sections below describe the single-library data flow, which is unchanged.

```
LLM client (Claude, IDE, etc.)
        │   JSON-RPC over stdio
        ▼
  @modelcontextprotocol/sdk Server
        │
        ▼
  protocol/ layer (tools.ts, resources.ts, router.ts)
        │   dispatch by tool name
        ▼
  domain/ layer (resolver, search, context, formatters)
        │   read-only access
        ▼
  data/ layer (paths → metadata → schema.parse → in-memory index)
        │
        ▼
  component-metadata.json (schema v4.x, produced by analyzer)
```

The binary entrypoint is `src/index.ts`. All library-specific behavior (selector prefix, package name, version) is **derived from the loaded metadata** at runtime — nothing is hardcoded per library.

---

## 2. Startup: Every Configurable Option

Command (after `npm run build`):

```bash
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json \
  node packages/mcp-server/dist/index.js
```

### 2.1 Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CL_MCP_METADATA_PATH` | no* | — | Direct path to a `component-metadata.json` file, **or** a directory containing one. Path-traversal (`..`) is rejected. Resolved to absolute. |
| `CL_MCP_DATA_DIR` | no* | — | Path to a parent data directory. The server scans immediate subdirectories for a `component-metadata.json`; first match wins. Also checks the root of `CL_MCP_DATA_DIR` itself. |
| — | — | convention | If neither env var is set, walks up from the dist folder looking for a monorepo root (`vitest.workspace.ts`) and scans `<root>/data/<lib>/component-metadata.json`. |

\* At least one resolution strategy must succeed, or startup fails with a clear error. Path resolution lives in `src/data/paths.ts:40` (`resolveMetadataPath`). The resolved path is frozen into the module-level `METADATA_PATH` constant.

### 2.2 What you cannot configure

- **Transport**: always `StdioServerTransport`. No HTTP / WebSocket. (The `@cl-mcp/cli` package drives the same `@cl-mcp/core` tool handlers over the shell.)
- **Tool list**: the 6 tools are hardcoded in `src/protocol/tools.ts`. Not plugin-extensible.
- **Keyword expansions** used by semantic search: hardcoded map in `src/domain/search.ts:204` (`DEFAULT_KEYWORD_EXPANSIONS`). No per-library tuning.
- **Score weights**: hardcoded in `src/domain/search.ts:31` (`SCORE`).
- **Template size cap** for `validate_template`: 100,000 characters, hardcoded in `src/protocol/router.ts:118` (`MAX_TEMPLATE_LENGTH`).
- **Multi-selector threshold** (switch from full API to index view): 3, hardcoded in `src/domain/formatters.ts:234` (`MULTI_SELECTOR_THRESHOLD`).
- **Selector filter exclusions** (`test-`, `storybook-`): hardcoded in `context.ts` / formatters when building the quick-reference.

### 2.3 LibraryConfig — what gets derived at startup

When `loadPreloadedMetadata()` succeeds, `src/data/metadata.ts:101` calls `setLibraryConfig({...})`:

- `packageName` ← `metadata.componentsPath.replace('node_modules/', '')` (e.g. `@angular/material`).
- `name` ← last segment of `packageName` (e.g. `material`).
- `selectorPrefix` ← regex-sniffed from the **first entry** in `metadata.selectorMap` (`^[a-z]+-`). Empty string if no selector map or no leading lowercase prefix.
- `version` ← `metadata.version` (the schema/analyzer version, e.g. `4.1.0`).

All downstream layers (resolver, search, formatters, context, resources) read `getLibraryConfig()` instead of hardcoding anything.

---

## 3. Startup Sequence

`src/index.ts`:

1. Construct `new Server({ name: 'cl-mcp-component-library-expert', version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } })`.
2. Register handlers **before** connecting the transport:
   - `registerResourceHandlers(server)` — `ListResourcesRequestSchema`, `ReadResourceRequestSchema`.
   - `registerToolDefinitions(server)` — `ListToolsRequestSchema` (static tool spec).
   - `registerToolHandlers(server)` — `CallToolRequestSchema` (dispatch table).
3. `main()` runs:
   - Logs banner to **stderr** (stdout is reserved for JSON-RPC).
   - `loadPreloadedMetadata()` — fail-fast. On any error, `process.exit(1)`.
   - Logs `packageName`, `version`, `selectorPrefix` to stderr.
   - `server.connect(new StdioServerTransport())` — now accepting messages.

### 3.1 Why stderr for all logs

stdout carries JSON-RPC framing. Any stray `console.log` would corrupt the client's parser. Every log site in this package uses `console.error`.

---

## 4. Data Layer (`src/data/`)

### 4.1 `paths.ts` — metadata path resolution

Cascading strategy (see §2.1). Each strategy returns as soon as it finds a file; otherwise falls through to the next. All user-supplied paths go through `validateSecurePath()` which rejects `..` segments.

### 4.2 `schema.ts` — trust-boundary Zod validator

The analyzer and server are separate packages that communicate **only through the JSON file**. The file might be stale, hand-edited, or from a major-version drift. `parseComponentMetadata(raw)` (`src/data/schema.ts:375`) is the single source of truth for what a valid metadata file looks like.

Key design choices (schema v4.x):

- **Discriminated unions** mirror the TS types exactly:
  - `InputProperty` on `required` — a required input **cannot** carry `defaultValue` (enforced via `.strict()` on the `required: true` branch).
  - `InjectedDependency` on `self` — `self: true` forces `skipSelf: false`.
  - `ExportedType` on `kind` — `interface`/`class` carry `TypeMember[]`, `enum` carries `EnumMember[]`, `type` carries no members.
  - `ComponentMetadataEntry` on `kind` — `analyzed` carries full payload; `skipped` / `failed` carry only `{name, reason}`.
- **Template XOR**: `template` and `templateUrl` are mutually exclusive (via `.refine()`).
- **Required-input strictness**: the `required: true` branch is `.strict()` so unknown/forbidden fields fail at parse time instead of being silently kept.
- **Failures throw a single `Error`** whose message enumerates every offending `path: message` pair — operators get one loud report, not a silent partial load.

### 4.3 `metadata.ts` — load, index, access

`loadPreloadedMetadata()`:

1. `fs.existsSync` check on `METADATA_PATH`, else throw with guidance.
2. `fs.readFileSync` → `JSON.parse` (wrapped; parse errors get a specific message).
3. `parseComponentMetadata(raw)` (Zod) → populates `_metadata`.
4. `buildImportedByIndex(_metadata)` — reverses `importsFrom` edges into each target's `importedBy`. **`importedBy` is not on disk** (would otherwise drift against `importsFrom`); it is derived once at load.
5. Schema-version sanity check — warns if `major !== 4`; does not refuse to load.
6. If `_metadata.diagnostics` is non-empty, logs each diagnostic code to stderr.
7. Derives and commits `LibraryConfig` via `setLibraryConfig(...)`.

Data accessors (all read-only):

- `getMetadata()` — throws if load hasn't happened yet.
- `getAvailableComponents()` — component name keys.
- `getPreloadedComponentMetadata(name)` — entry or `null`.
- `getAnalyzedEntry(nameOrEntry)` — narrows to `AnalyzedComponentEntry` (`kind === 'analyzed'`) or `null`. Centralizes the guard that was previously duplicated across domain files.
- `componentExists(name)`.
- `getComponentAnalysis(name)` — returns `readonly FileAnalysis[]` (empty when not analyzed).
- `extractSelectors` / `extractDirectiveSelectors` / `countDirectivesAndPipes` — thin pluckers.
- `buildSearchMetadataMap(components)` — `Map<name, {llmSummary, selectors}>` fed to the search engine.

### 4.4 `config.ts` — mutable singleton

`setLibraryConfig()` / `getLibraryConfig()` with a default fallback (`{name: 'component-library', selectorPrefix: '', packageName: 'unknown', version: '0.0.0'}`) so the domain layer never crashes even if config was not set.

---

## 5. Protocol Layer (`src/protocol/`)

### 5.1 `tools.ts` — static tool manifest

Responds to `ListToolsRequestSchema` with a fixed array of 5 tool specs (name, description, JSON Schema for `inputSchema`). This is pure metadata — no runtime state.

### 5.2 `router.ts` — dispatch

Responds to `CallToolRequestSchema`. Looks up `request.params.name` in a `TOOL_HANDLERS` table and calls the handler with `request.params.arguments`. Unknown names throw (surfaces as a JSON-RPC error to the client).

Each handler receives `Record<string, unknown>`, narrows it locally, and returns `ToolResponse = { content: [{type: 'text', text}], isError?: true }`.

| Tool | Handler | Notes |
|------|---------|-------|
| `get_library_overview` | `handleLibraryOverview` | Returns `text` (markdown) by default or `json` (QuickContext) via `format=json`. |
| `find_components` | `handleFindComponents` | Three modes: `query` → semantic search (top 5); `list_all=true` → compact listing; neither → listing with summaries. |
| `get_component` | `handleGetComponent` | Requires `componentName`. Resolves the name, then dispatches by `detail_level` ∈ {`api` (default), `full`, `examples`, `types`}. |
| `get_components_batch` | `handleGetComponentsBatch` | Iterates names, resolves each independently, concatenates sections with `---` separators. Per-name errors are inlined — **never aborts the whole batch**. |
| `validate_template` | `handleValidateTemplate` | Caps template length at 100k chars. Registers only the named components (+ their inherited inputs/outputs) on a fresh `TemplateValidator`, then runs `validate()`. |

### 5.3 `resources.ts` — MCP resources

Two URIs, parameterized by `config.name`:

- `cl-mcp://<lib>/quick-reference` (`text/plain`) → `formatQuickContextForLLM()`
- `cl-mcp://<lib>/selectors` (`application/json`) → selector map only

Unknown URIs throw.

---

## 6. Domain Layer (`src/domain/`)

### 6.1 `resolver.ts` — component name resolution

`resolveComponentName(input)` runs a cascade and returns `{resolved, matchedSelector?, type?}`, `{suggestions[]}`, or `{error}`:

1. **Exact key match** on `components` dict.
2. **Selector match** via `matchBySelector`:
   - Strip wrapping `<…>` if present.
   - Direct lookup in `metadata.selectorMap`.
   - With attribute brackets: `[input]`.
   - With prefix + capitalized first letter: e.g. `mat-` + `Button` → `[matButton]`.
   - Word-normalize (split on `-`/`_`/space, lowercase), then try `prefix + words.join('-')` and the same with sorted words.
   - Word-subset scan: compare sorted word arrays of query vs. every selector's stripped-of-prefix form.
3. **Substring fuzzy**: normalize (lowercase, strip `-`/`_`), `includes` either direction against every component name. Single hit → resolved; multiple → `suggestions`.
4. **Semantic fallback**: `matchBySemanticSearch` runs the search engine (§6.2). Single hit → resolved; multiple → `suggestions`; zero → `{error}` listing all components.

### 6.2 `search.ts` — semantic search engine

Generic, parametric (selector prefix from config, keyword expansions from a map). Public API: `searchComponents(query, components, metadataMap, options) → SearchResult[]` sorted by score desc.

**Query normalization** (`normalizeQuery`):
- Trim; convert camelCase → kebab-case via `([a-z])([A-Z]) → $1-$2`.
- Lowercase; strip library prefix.
- Split on whitespace / `-` / `_`.

**Per-component scoring** (`scoreComponent`) — sums all that apply:

| Signal | Weight | When it fires |
|--------|--------|---------------|
| Exact selector match | 20 | Normalized query equals a stripped selector (order-insensitive) |
| Partial selector match | 15 | Word subset (either direction) or string subset (either direction) |
| Name match | 10 | Component name `includes` normalized query (either direction) |
| Keyword expansion | 8 | Any query word appears in `DEFAULT_KEYWORD_EXPANSIONS`, and the expansion list contains this component name |
| Selector keyword | 5 | Every query word is a substring of some selector |
| Summary match | 3 | Any query word appears in `llmSummary` |

Components with `score === 0` are dropped. Ties are not broken (original component order preserved by the stable sort).

`DEFAULT_KEYWORD_EXPANSIONS` (≈45 synonyms) hardwires e.g. `dropdown` → `["select", "autocomplete", "listbox"]`, `notification` → `["toast", "feedback-panel", "snackbar", "snack-bar"]`, `loader` → progress components, etc.

### 6.3 `context.ts` — quick-reference generation

`getQuickContext()` is memoized (`cachedQuickContext`) — built once on first access.

`generateQuickContext()` has two paths:

- **Fast path**: if `metadata.selectorMap` is present (analyzer v4.x always emits it), use it directly, pair each component with a synthesized `import { ... } from '<packageName>/<componentName>'`.
- **Fallback**: walk every analyzed entry, skip `test-` / `storybook-` selectors, sort inputs (required first, then alphabetical), take the top 5 inputs and top 3 outputs, detect `formControl`/`formControlName`. Same treatment for directives (selectors stripped of brackets for the prefix test only).

`formatQuickContextForLLM()` renders the markdown overview: header, CRITICAL RULES (3-step flow, no hallucination), a `| Selector | Type | Main Inputs | Outputs | Form | Notes |` table, then directive and pipe tables when non-empty.

### 6.4 `formatters.ts` — response builders

Top-level response helpers: `jsonResponse(data)`, `textResponse(text)`, `errorResponse(msg)` (adds `isError: true`).

`requireComponent(name)` → either `{error: ToolResponse}` or `{resolved, matchedSelector?}`. Suggestions from the resolver are formatted as a "Did you mean" bullet list.

Detail-level handlers (all return `textResponse` except errors):

- **`handleComponentApi(name, selectorFilter?)`** — default. Builds `StrictComponentAPI` per component+directive via `buildStrictAPIFromAnalysis()`. If ≥3 sub-components and no selector filter, emits a compact "sub-components index" (selector table + shared inherited inputs) and returns early. Otherwise renders full per-selector sections: inputs, inherited inputs, outputs, inherited outputs, content projection slots, required providers. Appends the directives section and pipes table.
- **`handleComponentFull(name)`** — adds the `Summary`, `Inheritance`, `Config Tokens` (with defaults + provider snippet), `Related Components`, `Dependency Graph` (`importsFrom` / `importedBy`), `Usage Patterns`, and `README` sections. Refuses if `kind !== 'analyzed'`.
- **`handleComponentExamples(name)`** — curated examples, Storybook examples (template + args + option enums), common patterns, related components, config tokens.
- **`handleComponentTypes(name, selectorFilter?)`** — renders every `ExportedType` as a fenced TypeScript block by `kind`.

Unresolved types render as the sentinel `<unresolved>` (`formatters.ts:18`) — the schema v4.x convention that replaced the legacy `'unknown'` / `'void'` strings so the LLM can reliably distinguish "no type info" from a real type.

Search result formatting: `handleComponentSearch(query, components)` runs the engine, takes top 5, and renders each via `formatSearchResultEntry`: header, matched selector call-out, match reasons + score, summary (+ directives/pipes count), and the `basic` example template if present. `formatSearchFooter` prints a "use `get_component` with selector X/Y/Z" hint.

`handleComponentListing(components, listAll?)` renders a flat bullet list with selectors, directive/pipe counts, deprecation marker, and (unless `listAll`) the `llmSummary` as an em-dash suffix.

---

## 7. Template Validation

`validate_template` is the server's "hallucination guard". Flow in `handleValidateTemplate` (`src/protocol/router.ts:116`):

1. Reject missing/oversize template or empty `componentNames` array.
2. Instantiate `new TemplateValidator({selectorPrefix, libraryName})` — imported from `@cl-mcp/analyzer` (re-exported via `src/types.ts`). Each call gets a **fresh validator** — no cross-request state leak.
3. For each named component that `componentExists`:
   - `registerFromAnalysis(analyses)` — loads selectors/inputs/outputs onto the validator.
   - For every `inheritance[className]` entry, `registerInheritedProperties(inh.inheritedInputs, inh.inheritedOutputs)` so templates using inherited props don't false-positive.
4. `validator.validate(template)` returns `{errors, …}`.
5. **Result contract**:
   - Zero errors → `jsonResponse({valid: true, message, registeredSelectors})`.
   - Any errors → `textResponse(formatValidationResult(result))` with `isError: true` (human-readable; the caller's LLM gets structured error lines).

Only components the caller names are registered, keeping the validator's "known surface" scoped to the template under review.

Registered selectors are parsed into per-comma clause matchers, so hosts matched only via compound attribute selectors (`<button mat-button>` for `button[mat-button], a[mat-button]`) are fully validated — a binding is valid if ANY matched API (component + host directives) declares it. `:not(...)` clauses match conservatively and don't enforce required inputs.

---

## 8. Request Lifecycle (end to end)

Example: client sends `tools/call` for `get_component` with `{componentName: "button", detail_level: "api"}`.

1. `StdioServerTransport` reads the framed JSON-RPC message from stdin.
2. SDK Server matches `CallToolRequestSchema` and invokes the router's handler.
3. `TOOL_HANDLERS["get_component"]` → `handleGetComponent`.
4. `requireComponent("button")`:
   - `resolveComponentName("button")` → exact miss → selector miss → substring `"button"` ⊂ `"mat-button"`? Yes → resolved.
5. `formatByDetailLevel("api", "mat-button", matchedSelector)` → `handleComponentApi`.
6. Reads `getComponentAnalysis("mat-button")`, builds strict APIs, renders markdown.
7. Return `{content: [{type: "text", text: "# API Reference: <button[mat-button]>\n..."}]}`.
8. SDK frames and writes the JSON-RPC response to stdout.

---

## 9. Output Shape (contract)

All tool responses follow:

```ts
{
  content: [{ type: "text", text: string }],
  isError?: true
}
```

- **Markdown text** for everything human-readable (API refs, overviews, search results, template error reports).
- **JSON text** (stringified) for structured data: `get_library_overview` with `format=json` and the `valid: true` branch of `validate_template`.
- **`isError: true`** is set only when the operation itself failed (unresolved component, template too long, validation errors). The SDK propagates this to the client so LLMs can distinguish "tool ran but rejected" from "tool succeeded".

Resources (`resources/read`) return `{contents: [{uri, mimeType, text}]}` — two MIME types: `text/plain` for the quick-reference markdown, `application/json` for the selector map.

---

## 10. Error Handling Principles

- **Fail fast on load**: any schema violation, file-not-found, or JSON parse error exits the process before the transport accepts connections. There is no "degraded mode" that would let silent drift rot for months.
- **Per-request errors are scoped**: a bad component name in a batch returns an inlined error for that name only; the other names succeed. A bad `detail_level` returns `errorResponse`, not a throw.
- **All logs to stderr**: see §3.1.
- **`importedBy` is computed, not trusted**: keeping it off-disk eliminates a whole class of drift between `importsFrom` and `importedBy`.

---

## 11. What Lives Where (file map)

```
src/
├── index.ts                   # bin entry: boot + stdio transport
├── config.ts                  # LibraryConfig singleton + version constants
├── types.ts                   # re-exports analyzer types, validator, formatter
├── protocol/
│   ├── tools.ts               # ListToolsRequestSchema → static 5-tool spec
│   ├── router.ts              # CallToolRequestSchema → dispatch table + handlers
│   └── resources.ts           # resources/list + resources/read
├── domain/
│   ├── resolver.ts            # cascade: exact → selector → fuzzy → semantic
│   ├── search.ts              # scoring engine + keyword expansions
│   ├── context.ts             # quick-reference (markdown + JSON)
│   └── formatters.ts          # per-detail-level markdown builders
└── data/
    ├── paths.ts               # CL_MCP_METADATA_PATH / CL_MCP_DATA_DIR / convention
    ├── metadata.ts            # load + index + accessors
    └── schema.ts              # Zod trust-boundary validator
```

---

## 12. What This Server Does NOT Do

- Does not read TypeScript or Angular source — only the pre-generated JSON.
- Does not write files or mutate metadata.
- Does not cache per-request or across requests beyond `QuickContext` memoization and the in-memory metadata dict.
- Does not implement authentication, rate limiting, or transport other than stdio.
- Does not phone home or emit telemetry.
- Does not know anything library-specific at compile time — swap the metadata file, restart, and the same binary serves a different component library.
