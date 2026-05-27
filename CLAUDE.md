# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

cl-mcp is a monorepo that provides an MCP (Model Context Protocol) server for component library metadata. It has two packages:

- **`@cl-mcp/analyzer`** — Build-time AST analysis of component libraries (currently Angular). Parses TypeScript source to extract component metadata (inputs, outputs, selectors, inheritance, content projection, config tokens, deprecation, storybook examples, import graphs). Outputs a `component-metadata.json` file.
- **`@cl-mcp/mcp-server`** — Runtime MCP server that loads pre-generated `component-metadata.json` and exposes it to LLMs via MCP tools and resources over stdio transport.

The pipeline: `analyzer CLI → component-metadata.json → MCP server → LLM tools`

## Commands

```bash
npm run build          # Build all packages (tsc in each workspace)
npm test               # Run all tests via vitest
npm run lint           # Lint with biome
npm run lint:fix       # Auto-fix lint issues
npm run clean          # Remove dist/ from all packages

# Per-package
npm test -w packages/analyzer
npm test -w packages/mcp-server
npx vitest run packages/analyzer/src/some.test.ts  # Single test file

# CLI tools (after build)
node packages/analyzer/dist/cli/generate-metadata.js --framework angular --path <library-path> --package <name> [--prefix <selector-prefix>] [--storybook <path>] [--docs <path>] [--output <path>]

# Running the MCP server
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json node packages/mcp-server/dist/index.js
```

## Architecture

### Analyzer (`packages/analyzer`)

- `src/types.ts` — Canonical type definitions for the entire metadata schema (v3.0). Both packages share these types.
- `src/analyzers/angular/angular-analyzer.ts` — Core AST analyzer using the TypeScript compiler API. Extracts components, directives, pipes, services, inputs, outputs, inheritance, content projection, deprecation, and config tokens.
- `src/analyzers/angular/storybook-extractor.ts` — Parses Storybook story files to extract usage examples.
- `src/shared/import-graph.ts` — Builds inter-component dependency graphs, co-occurrence data from storybook, and related component suggestions.
- `src/shared/template-validator.ts` — Validates Angular templates against extracted component APIs (catches hallucinated inputs/outputs).
- `src/cli/generate-metadata.ts` — CLI entry point that orchestrates the full analysis pipeline.
- `src/analyzers/analyzer.interface.ts` — Framework analyzer interface (designed for future framework support beyond Angular).

### MCP Server (`packages/mcp-server`)

Layered architecture:
- **Protocol layer** (`src/protocol/`) — MCP tool/resource definitions and request routing. `tools.ts` defines the 5 MCP tools, `router.ts` dispatches to domain handlers, `resources.ts` serves quick-reference resources.
- **Domain layer** (`src/domain/`) — Business logic. `search.ts` (semantic search with keyword expansion), `resolver.ts` (name resolution cascade: exact → selector → fuzzy → semantic), `formatters.ts` (output formatting), `context.ts` (quick context generation).
- **Data layer** (`src/data/`) — `metadata.ts` loads and provides access to component-metadata.json. `paths.ts` resolves the metadata file path via env vars (`CL_MCP_METADATA_PATH`, `CL_MCP_DATA_DIR`).
- `src/config.ts` — Runtime config derived from loaded metadata (library name, selector prefix, version).

### MCP Tools Exposed

1. `get_library_overview` — Compact reference of all components
2. `find_components` — Search/browse components (semantic search or listing)
3. `get_component` — Detailed info for one component (api/full/examples/types detail levels)
4. `get_components_batch` — Batch version of get_component
5. `validate_template` — Validates Angular templates against actual component APIs

## Key Conventions

- **TypeScript ESM** — All packages use `"type": "module"` with Node16 module resolution. Imports must include `.js` extensions.
- **Biome** for linting/formatting — 2-space indent, 120 char line width, recommended rules. `data/` and `example-code/` are excluded from linting.
- **Vitest** for testing — workspace config at root, per-package vitest configs.
- **No hardcoded library values** in the MCP server — all library-specific behavior (selector prefix, package name) is derived from loaded metadata at runtime.
- The `mcp-server` has `@cl-mcp/analyzer` as a peer dependency and re-exports its types via `src/types.ts`.

## Example Project

`examples/angular-material/` is a standalone (non-workspace) project for end-to-end testing of the full pipeline against Angular Material.

```bash
npm run example:setup    # Build packages + install Angular Material deps
npm run example:run      # Analyze Angular Material + verify MCP server responds
```

The analyzer outputs `examples/angular-material/data/component-metadata.json` (gitignored). The verify script spawns the MCP server, sends JSON-RPC requests, and asserts all 5 tools work.
