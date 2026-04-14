# cl-mcp

MCP (Model Context Protocol) server for component library metadata. Gives LLMs accurate knowledge about your Angular component library — selectors, inputs, outputs, types, examples, and template validation.

**Pipeline:** `analyzer CLI → component-metadata.json → MCP server → LLM tools`

## Packages

| Package | Description |
|---------|-------------|
| [`@cl-mcp/analyzer`](packages/analyzer/README.md) | Build-time AST analysis of Angular component libraries. Parses TypeScript source and outputs `component-metadata.json`. |
| [`@cl-mcp/mcp-server`](packages/mcp-server/README.md) | Runtime MCP server that loads metadata and exposes it to LLMs via MCP tools over stdio. |

## Quick start

```bash
# Install dependencies
npm install

# Build all packages
npm run build
```

## Development

### Prerequisites

- Node.js >= 18
- npm (workspaces)

### Build & test

```bash
npm run build          # Build all packages (tsc)
npm test               # Run all tests (vitest)
npm run lint           # Lint with biome
npm run lint:fix       # Auto-fix lint issues
npm run clean          # Remove dist/ from all packages

# Per-package
npm test -w packages/analyzer
npm test -w packages/mcp-server

# Single test file
npx vitest run packages/analyzer/src/some.test.ts
```

### Code conventions

- **TypeScript ESM** — all packages use `"type": "module"` with Node16 module resolution. Imports must include `.js` extensions.
- **Biome** — 2-space indent, 120 char line width.
- **Vitest** for testing.

## Generating metadata

The analyzer CLI scans an Angular component library and produces a `component-metadata.json` file containing all component/directive/pipe metadata.

```bash
node packages/analyzer/dist/cli/generate-metadata.js \
  --framework angular \
  --path <library-source-path> \
  --package <package-name> \
  [--prefix <selector-prefix>] \
  [--storybook <storybook-path>] \
  [--docs <docs-file-path>] \
  [--output <output-path>]
```

### Options

| Flag | Required | Description |
|------|----------|-------------|
| `--framework` | No | Framework to analyze (default: `angular`) |
| `--path` | Yes | Path to component library source (e.g. `./node_modules/@angular/material`) |
| `--package` | No | Package name (default: derived from path) |
| `--prefix` | No | Selector prefix to filter components (e.g. `mat`) |
| `--storybook` | No | Path to storybook directory for usage examples |
| `--docs` | No | Path to library documentation file |
| `--output` | No | Output path (default: `./component-metadata.json`) |

### What the analyzer extracts

- Components, directives, pipes with their selectors
- Inputs (with types, defaults, required flag) and outputs
- Inheritance chains and inherited inputs/outputs
- Content projection slots (`<ng-content>`)
- Config tokens (InjectionToken)
- Deprecation info
- Storybook usage examples
- Inter-component dependency graph and related component suggestions

## Running the MCP server

The MCP server loads a pre-generated `component-metadata.json` and serves it over stdio transport.

### Configuration

The server finds metadata via environment variables (checked in order):

1. **`CL_MCP_METADATA_PATH`** — direct path to `component-metadata.json`
2. **`CL_MCP_DATA_DIR`** — directory containing subdirectories with metadata files
3. Falls back to `data/` directory relative to workspace root

### Start the server

```bash
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json \
  node packages/mcp-server/dist/index.js
```

### Connecting to an LLM client

Add the server to your MCP client configuration. Example for Claude Code (`~/.claude/mcp_servers.json`):

```json
{
  "cl-mcp": {
    "command": "node",
    "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
    "env": {
      "CL_MCP_METADATA_PATH": "/absolute/path/to/data/angular-material/component-metadata.json"
    }
  }
}
```

For Cursor, VS Code with Continue, or other MCP-compatible clients — add the same `command`, `args`, and `env` to their respective MCP server config.

### MCP tools exposed

| Tool | Description |
|------|-------------|
| `get_library_overview` | Compact reference of all components with selectors and inputs |
| `find_components` | Search by name, keyword, selector, or intent (semantic search) |
| `get_component` | Detailed info for one component (`api`/`full`/`examples`/`types` detail levels) |
| `get_components_batch` | Batch version of `get_component` |
| `validate_template` | Validate Angular templates against actual component APIs |

**Recommended flow:** `get_library_overview` → `find_components` → `get_component` → `validate_template`

## End-to-end example (Angular Material)

The `examples/angular-material/` directory contains a full pipeline test against Angular Material:

```bash
# Setup: build packages + install Angular Material
npm run example:setup

# Run: analyze Angular Material + verify MCP server responds
npm run example:run
```

This generates `data/angular-material/component-metadata.json` and verifies all 5 MCP tools work correctly.

## Project structure

```
cl-mcp/
├── packages/
│   ├── analyzer/              # @cl-mcp/analyzer
│   │   ├── src/
│   │   │   ├── types.ts                  # Canonical metadata schema (v4.x)
│   │   │   ├── analyzers/angular/        # Angular AST analyzer, storybook extractor
│   │   │   ├── shared/                   # Import graph, template validator
│   │   │   └── cli/                      # generate-metadata.ts CLI entry point
│   │   └── package.json
│   └── mcp-server/            # @cl-mcp/mcp-server
│       ├── src/
│       │   ├── index.ts                  # Server entry point (stdio transport)
│       │   ├── config.ts                 # Runtime config from metadata
│       │   ├── protocol/                 # MCP tool/resource definitions, routing
│       │   ├── domain/                   # Search, resolver, formatters
│       │   └── data/                     # Metadata loading, path resolution
│       └── package.json
├── examples/angular-material/  # E2E pipeline test
├── data/                       # Generated metadata (gitignored)
└── package.json                # Workspace root
```
