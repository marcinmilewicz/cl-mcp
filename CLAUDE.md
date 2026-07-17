# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

cl-mcp is a monorepo that provides an MCP (Model Context Protocol) server for component library metadata. It has four packages:

- **`@cl-mcp/analyzer`** — Build-time AST analysis of component libraries (**Angular and React**). Parses TypeScript/TSX source to extract component metadata (inputs/props, outputs/callbacks, selectors/JSX names, inheritance, content projection, config tokens, deprecation, storybook examples, import graphs). Outputs one `component-metadata.json` per library, plus a `workspace-manifest.json` in multi-library mode.
- **`@cl-mcp/core`** — Transport-agnostic core: metadata loading (multi-library registry + Zod trust boundary), the search/resolution domain, and the tool handlers (pure `args → ToolResponse` functions, no SDK dependency). Importing it has no side effects.
- **`@cl-mcp/mcp-server`** — Thin MCP protocol (stdio) adapter over core: registers the tool schemas, routes `tools/call` to core's `TOOL_HANDLERS`, serves per-library quick-reference resources.
- **`@cl-mcp/cli`** — Thin shell adapter over core: `cl-mcp` bin with the same tool handlers (for agents without an MCP client, CI, humans).

The pipeline: `analyzer CLI → component-metadata.json (per library) + workspace-manifest.json → MCP server / cl-mcp CLI → LLM tools`

## Commands

```bash
npm run build          # Build all packages (tsc, dependency order: analyzer → core → mcp-server → cli)
npm test               # Run all tests via vitest
npm run lint           # Lint with biome
npm run lint:fix       # Auto-fix lint issues
npm run clean          # Remove dist/ from all packages

# Per-package
npm test -w packages/analyzer
npm test -w packages/mcp-server
npm test -w packages/cli
npx vitest run packages/analyzer/src/some.test.ts  # Single test file

# Metadata generation (after build)
# single library:
node packages/analyzer/dist/cli/generate-metadata.js --framework angular|react --path <library-path> --package <name> [--prefix <selector-prefix>] [--storybook <path>] [--docs <path>] [--output <path>]
# multi-library workspace (cl-mcp.yaml or ad hoc):
node packages/analyzer/dist/cli/generate-metadata.js --config ./cl-mcp.yaml
node packages/analyzer/dist/cli/generate-metadata.js --lib libs/ui --lib libs/forms --output-dir ./data
node packages/analyzer/dist/cli/generate-metadata.js --scan libs --output-dir ./data

# Running the MCP server
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json node packages/mcp-server/dist/index.js  # single library
CL_MCP_DATA_DIR=./data node packages/mcp-server/dist/index.js                                                # all libraries in dir

# The cl-mcp CLI
node packages/cli/dist/index.js list-libraries --data-dir ./data
node packages/cli/dist/index.js get ui:Button --data-dir ./data
```

## Architecture

### Analyzer (`packages/analyzer`)

- `src/types.ts` — Canonical type definitions for the entire metadata schema (v4.2: `framework`, `libraryName`, `WorkspaceManifest`). All packages share these types.
- `src/analyzers/analyzer.interface.ts` — `FrameworkAnalyzer` interface; both framework pipelines implement it and the CLI dispatches via a registry.
- `src/analyzers/angular/angular-analyzer.ts` — Core Angular AST analyzer (TypeScript compiler API): components, directives, pipes, services, inputs, outputs, inheritance, content projection, deprecation, config tokens.
- `src/analyzers/angular/angular-framework-analyzer.ts` — Angular `FrameworkAnalyzer`: full pipeline orchestration (discovery → ts.Program → per-component analysis → selector map → storybook token resolution → related components).
- `src/analyzers/react/react-analyzer.ts` — React AST core: detects function/arrow/class components (incl. `memo`/`forwardRef`/`React.FC<P>`), extracts props via the TypeChecker (required/defaults/literal unions/JSDoc), classifies `/^on[A-Z]/` callbacks as outputs, `children`/ReactNode props as slots. Emits the SAME `FileAnalysis` shapes as Angular so all consumers work unchanged.
- `src/analyzers/react/react-framework-analyzer.ts` — React `FrameworkAnalyzer` (flat file discovery, entry per component keyed by JSX name).
- `src/analyzers/react/jsx-validator.ts` — JSX usage validation (unknown/missing-required props, Levenshtein suggestions, spread-aware).
- `src/analyzers/react/react-storybook-extractor.ts` — CSF story parsing (best effort; `usedComponents` only when a `render()` JSX exists).
- `src/workspace/` — multi-library layer: `config.ts` (`cl-mcp.yaml`, Zod-validated), `framework-detector.ts` (deps → source scan), `library-discovery.ts` (explicit entries + scan dirs; aliases from tsconfig paths → package.json → relative path; NOT coupled to NX), `workspace-orchestrator.ts` (runs the right analyzer per library, writes per-library metadata + manifest with cross-library import graph).
- `src/shared/import-graph.ts` — Inter-component dependency graphs, storybook co-occurrence, related component suggestions (framework-agnostic).
- `src/shared/template-validator.ts` — Validates Angular templates against extracted component APIs.
- `src/cli/generate-metadata.ts` — CLI dispatcher: single-library mode (`--framework`/`--path`) or workspace mode (`--config`/`--scan`/`--lib`).

### Core (`packages/core`)

Layered, transport-agnostic:
- **Application layer** (`src/handlers.ts`) — the 6 tool handlers as pure `args → ToolResponse` functions (`TOOL_HANDLERS`). Owns multi-library resolution: `library` argument, `lib:Name` qualifiers, cross-library component resolution, framework-dispatched validation (JSX vs template).
- **Domain layer** (`src/domain/`) — `search.ts` (semantic search), `resolver.ts` (name cascade: exact → selector → fuzzy → semantic), `formatters.ts` (output formatting; renders JSX-style binding examples for React libraries), `context.ts` (quick context, memoized per library).
- **Data layer** (`src/data/`) — `registry.ts` loads EVERY resolvable metadata file and keeps them keyed by library name; domain code reads one "active" library via the legacy accessors in `metadata.ts` and handlers switch it per request with `withLibrary()` (handlers are synchronous, so this is safe). `paths.ts` resolves all metadata paths (`CL_MCP_METADATA_PATH` = single, `CL_MCP_DATA_DIR` = all subdirs) — single file = single-library mode, fully backward compatible. `schema.ts` is the Zod trust boundary.
- `src/config.ts` — Runtime `LibraryConfig` (name, prefix, packageName, version, framework) for the active library.

### MCP Server (`packages/mcp-server`)

Pure protocol adapter (`src/protocol/`): `tools.ts` defines the 6 MCP tool schemas, `router.ts` routes `tools/call` to core's `TOOL_HANDLERS`, `resources.ts` serves per-library quick-reference resources. `src/index.ts` boots the stdio transport (fail-fast metadata load).

### MCP Tools Exposed

1. `get_library_overview` — Compact reference (per-library sections in multi-library mode)
2. `find_components` — Search/browse components (semantic search or listing)
3. `get_component` — Detailed info for one component (api/full/examples/types detail levels)
4. `get_components_batch` — Batch version of get_component
5. `validate_template` — Validates Angular templates (refuses React libraries, pointing to validate_usage)
6. `validate_usage` — Framework-dispatched validation: JSX for React, templates for Angular

Every tool accepts an optional `library` argument; component names accept `lib:Name` qualifiers.

## Key Conventions

- **TypeScript ESM** — All packages use `"type": "module"` with Node16 module resolution. Imports must include `.js` extensions.
- **Biome** for linting/formatting — 2-space indent, 120 char line width, recommended rules. `data/` and `example-code/` are excluded from linting. The repo carries some pre-existing lint errors; keep files you touch clean but don't chase the backlog.
- **Vitest** for testing — workspace config at root, per-package vitest configs. Analyzer/CLI configs use a 20s `testTimeout` because ts.Program creation in fixtures is slow cold.
- **No hardcoded library values** in core/server — all library-specific behavior (selector prefix, package name, framework) is derived from loaded metadata at runtime.
- `@cl-mcp/core` has `@cl-mcp/analyzer` as a peer dependency and re-exports its types via `src/types.ts`; `mcp-server` and `cli` depend on core and never re-implement domain logic.
- **React emits Angular-shaped structures** — the React analyzer reuses `FileAnalysis`/`ComponentAnalysis` (JSX name as `selector`, props as `inputs`, callbacks as `outputs`) so the server/formatters need no per-framework branches beyond example rendering and validation dispatch.

## Example Projects

```bash
# Angular Material (single library, sources fetched on setup)
npm run example:setup
npm run example:run      # analyze + verify all 6 MCP tools

# Mixed React + Angular workspace (committed fixture)
npm run example:multi    # cl-mcp.yaml generation + MCP multi-library + CLI verification
```

`examples/multi-framework/` is deliberately two different layouts — `libs/ui` (React, flat) and `libs/forms` (Angular, directory-per-component) — so the pipeline is tested against both. Generated `data/` outputs are gitignored in both examples.
