# cl-mcp

MCP (Model Context Protocol) server for component library metadata. Gives LLMs accurate knowledge about your **Angular and React** component libraries — selectors/JSX names, inputs/props, outputs/callbacks, types, examples, and usage validation. Handles single libraries and whole monorepos (`libs/ui`, `libs/forms`, …) with one config file.

**Pipeline:** `analyzer CLI → component-metadata.json (per library) + workspace-manifest.json → MCP server / cl-mcp CLI → LLM tools`

## Packages

| Package | Description |
|---------|-------------|
| [`@cl-mcp/analyzer`](packages/analyzer/README.md) | Build-time AST analysis of Angular and React component libraries. Parses TypeScript/TSX source and outputs `component-metadata.json` (+ a workspace manifest in multi-library mode). |
| `@cl-mcp/core` | Transport-agnostic core: multi-library metadata registry (Zod trust boundary), search/resolution domain, and the tool handlers shared by both frontends. |
| [`@cl-mcp/mcp-server`](packages/mcp-server/README.md) | Thin MCP protocol adapter over core — serves the tool handlers to LLMs via stdio. |
| [`@cl-mcp/cli`](packages/cli/README.md) | Thin shell adapter over core — `cl-mcp` bin with the same tools. For agents without an MCP client, CI, and humans. |

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
npm run build          # Build all packages (tsc, dependency order)
npm test               # Run all tests (vitest)
npm run lint           # Lint with biome
npm run lint:fix       # Auto-fix lint issues
npm run clean          # Remove dist/ from all packages

# Per-package
npm test -w packages/analyzer
npm test -w packages/mcp-server
npm test -w packages/cli

# Single test file
npx vitest run packages/analyzer/src/some.test.ts
```

### Code conventions

- **TypeScript ESM** — all packages use `"type": "module"` with Node16 module resolution. Imports must include `.js` extensions.
- **Biome** — 2-space indent, 120 char line width.
- **Vitest** for testing.

## Generating metadata

### Multi-library workspace (recommended)

Describe your libraries once in `cl-mcp.yaml` at the repo root:

```yaml
outputDir: ./data

libraries:
  - path: libs/forms          # explicit entry; framework auto-detected
    prefix: org-              # Angular selector prefix (optional)
  - path: libs/ui
    framework: react          # or let detection handle it
    importAlias: "@myorg/ui"  # else read from tsconfig paths / package.json

scan:                         # optionally: every subdirectory is a candidate
  - dir: libs
    exclude: ["*-e2e", "*-testing"]
```

```bash
node packages/analyzer/dist/cli/generate-metadata.js --config ./cl-mcp.yaml
# or ad hoc, no config file:
node packages/analyzer/dist/cli/generate-metadata.js --lib libs/ui --lib libs/forms --output-dir ./data
node packages/analyzer/dist/cli/generate-metadata.js --scan libs --output-dir ./data
```

This writes `data/<library>/component-metadata.json` per library plus
`data/workspace-manifest.json` (library list + cross-library import graph).
Frameworks are auto-detected (package.json deps → decorator/JSX source scan);
import aliases come from `tsconfig.base.json` paths, a library's
`package.json` name, or relative paths — **no NX or other workspace tool
required**.

### Single library

```bash
node packages/analyzer/dist/cli/generate-metadata.js \
  --framework angular|react \
  --path <library-source-path> \
  --package <package-name> \
  [--prefix <selector-prefix>] \
  [--storybook <storybook-path>] \
  [--docs <docs-file-path>] \
  [--output <output-path>]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--framework` | No | `angular` (default) or `react` |
| `--path` | Yes | Path to component library source (e.g. `./node_modules/@angular/material`) |
| `--package` | No | Package name (default: derived from path) |
| `--prefix` | No | Selector prefix to filter components (Angular; e.g. `mat`) |
| `--storybook` | No | Path to storybook directory for usage examples |
| `--docs` | No | Path to library documentation file |
| `--output` | No | Output path (default: `./component-metadata.json`) |

### What the analyzer extracts

**Angular** — components, directives, pipes with selectors; inputs (types, defaults, required) and outputs; inheritance chains; content projection slots (`<ng-content>`); config tokens (InjectionToken); deprecation; Storybook examples; inter-component dependency graph.

**React** — exported function/arrow/class components (including `memo()`/`forwardRef()` wrappers, custom factories like `fastComponent(fn)`, `React.FC<P>` annotations, and helper-rendered components detected via the checker's return type); props via the TypeScript checker (required/optional, destructured defaults, literal-union values, JSDoc); callback props (`/^on[A-Z]/`) as outputs; `children` + ReactNode props as content slots; `@deprecated`; **compound public names** from namespace barrels (`export * as Dialog from './index.parts'` → the component is served as `Dialog.Root`, with the internal `DialogRoot` kept in `exports` and still resolvable); CSF Storybook stories (best effort); import graph.

> For best React results have `react` + `@types/react` resolvable from the analyzed sources (installed in any ancestor directory) — without them prop-type resolution degrades and helper-rendered components go undetected. See `examples/react-base-ui/` for the real-world reference setup (MUI Base UI: 221 components, 97% prop types resolved).

## Running the MCP server

The server loads pre-generated metadata and serves it over stdio transport.

### Configuration

Metadata resolution (checked in order):

1. **`CL_MCP_METADATA_PATH`** — direct path to a single `component-metadata.json` (single-library mode)
2. **`CL_MCP_DATA_DIR`** — directory of per-library metadata; **every** `<dir>/<lib>/component-metadata.json` is loaded (multi-library mode)
3. Falls back to `data/` relative to the workspace root (all libraries inside)

### Start the server

```bash
# single library
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json \
  node packages/mcp-server/dist/index.js

# whole workspace
CL_MCP_DATA_DIR=./data node packages/mcp-server/dist/index.js
```

### Connecting to an LLM client

Example for Claude Code (`~/.claude/mcp_servers.json`):

```json
{
  "cl-mcp": {
    "command": "node",
    "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
    "env": {
      "CL_MCP_DATA_DIR": "/absolute/path/to/data"
    }
  }
}
```

For Cursor, VS Code with Continue, or other MCP-compatible clients — add the same `command`, `args`, and `env` to their respective MCP server config.

### MCP tools exposed

| Tool | Description |
|------|-------------|
| `get_library_overview` | Compact reference of all components (per-library sections in multi-library mode) |
| `find_components` | Search by name, keyword, selector, or intent (semantic search) |
| `get_component` | Detailed info for one component (`api`/`full`/`examples`/`types` detail levels) |
| `get_components_batch` | Batch version of `get_component` |
| `validate_template` | Validate Angular templates against actual component APIs |
| `validate_usage` | Framework-dispatched validation: JSX for React libraries, templates for Angular |

Every tool accepts an optional `library` argument; component names accept a
`lib:Name` qualifier (e.g. `ui:Button`). Unqualified names resolve across all
loaded libraries — an unambiguous hit wins, ambiguity returns qualified
suggestions. React compound names resolve in both forms: `Dialog.Root` and
`DialogRoot` reach the same component, and `validate_usage` accepts both
`<Dialog.Root>` and `<DialogRoot>` JSX tags.

**Recommended flow:** `get_library_overview` → `find_components` → `get_component` → `validate_usage`

## The `cl-mcp` CLI (no MCP client required)

```bash
node packages/cli/dist/index.js list-libraries --data-dir ./data
node packages/cli/dist/index.js get ui:Button --detail api --data-dir ./data
node packages/cli/dist/index.js validate --components Button --code '<Button disabled={true} />' --data-dir ./data
```

Same handlers as the MCP tools; markdown to stdout, logs to stderr, exit
codes `0`/`1`/`2` (ok / tool rejected / operational error).

Help is written for agents: `cl-mcp --help` leads with the recommended
workflow (`overview → find → get → validate`) and the output/exit-code
contract; `cl-mcp help <command>` (or `<command> --help`) prints detailed,
example-driven help including the semantics an agent must know (validate
checks prop *names* not values, spread props skip required-prop checks,
`Dialog.Root` ≡ `DialogRoot`). See
[`packages/cli/README.md`](packages/cli/README.md).

## End-to-end examples

```bash
# Angular Material (single library)
npm run example:setup    # build packages + fetch Angular Material sources
npm run example:run      # analyze + verify all MCP tools

# Mixed React + Angular workspace (multi-library)
npm run example:multi    # generate from cl-mcp.yaml + verify MCP server & CLI

# Real-world React library (MUI Base UI, pinned tag)
npm run example:react-setup   # sparse-clone Base UI + install react/@types/react
npm run example:react         # analyze + verify quality floors, MCP server & CLI

# Second real-world Angular library (NG-ZORRO, pinned tag)
npm run example:ngzorro-setup
npm run example:ngzorro       # 83 components, 1044 selectors; validates beyond Material conventions

# shadcn/ui-style in-repo components (committed fixture)
npm run example:shadcn-setup
npm run example:shadcn        # cva VariantProps, Radix wrappers, export{} pattern
```

Upstream clones are pinned to release tags (`ANGULAR_COMPONENTS_REF`,
`BASE_UI_REF`, `NG_ZORRO_REF` env vars override) — bump deliberately, never
track a moving branch.

`examples/multi-framework/` is a committed fixture: `libs/ui` (React, flat
layout) + `libs/forms` (Angular, directory-per-component) + `tsconfig.base.json`
paths + `cl-mcp.yaml` — deliberately two different layouts so the pipeline is
tested against both.

## Project structure

```
cl-mcp/
├── packages/
│   ├── analyzer/              # @cl-mcp/analyzer
│   │   ├── src/
│   │   │   ├── types.ts                  # Canonical metadata schema (v4.2)
│   │   │   ├── analyzers/angular/        # Angular AST analyzer + framework analyzer
│   │   │   ├── analyzers/react/          # React AST analyzer, JSX validator, CSF extractor
│   │   │   ├── workspace/                # cl-mcp.yaml config, discovery, orchestrator
│   │   │   ├── shared/                   # Import graph, template validator, diagnostics
│   │   │   └── cli/                      # generate-metadata.ts CLI entry point
│   │   └── package.json
│   ├── core/                  # @cl-mcp/core (transport-agnostic)
│   │   ├── src/
│   │   │   ├── handlers.ts               # Tool handlers (args → ToolResponse, no SDK)
│   │   │   ├── config.ts                 # Runtime config from metadata
│   │   │   ├── domain/                   # Search, resolver, formatters, context
│   │   │   └── data/                     # Registry (multi-library), loading, Zod schema
│   │   └── package.json
│   ├── mcp-server/            # @cl-mcp/mcp-server (MCP protocol adapter)
│   │   ├── src/
│   │   │   ├── index.ts                  # Server entry point (stdio transport)
│   │   │   └── protocol/                 # MCP tool/resource definitions, routing
│   │   └── package.json
│   └── cli/                   # @cl-mcp/cli (bin: cl-mcp, shell adapter)
├── examples/angular-material/  # E2E pipeline test (single library)
├── examples/multi-framework/   # E2E pipeline test (React + Angular workspace)
├── data/                       # Generated metadata (gitignored)
└── package.json                # Workspace root
```
