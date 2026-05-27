# Angular Material Example

End-to-end test of the cl-mcp pipeline: analyzer → metadata → MCP server.

The analyzer needs TypeScript **source** with `@Component` / `@Input` decorators — the npm-published `@angular/material` package ships only compiled `.mjs` + `.d.ts`, so this example clones the official [`angular/components`](https://github.com/angular/components) repo and points the analyzer at `src/material`.

## Prerequisites

- Node.js 18+, `git` on PATH
- Build the monorepo first: `npm run build` from the repo root

## Quick Start

```bash
# From the repo root:
npm run example:setup    # builds packages + clones angular/components
npm run example:run      # analyzes + verifies MCP server

# Or manually from this directory:
npm run setup
npm run pipeline
```

To pin a specific ref (tag/branch) instead of `main`:

```bash
ANGULAR_COMPONENTS_REF=21.2.x npm run setup
```

## Scripts

| Script     | Description                                                       |
|------------|-------------------------------------------------------------------|
| `setup`    | Clone `angular/components` into `./components` (idempotent)       |
| `analyze`  | Run the analyzer against `./components/src/material`              |
| `serve`    | Start the MCP server (uses metadata from `./data/`)               |
| `verify`   | Smoke test: spawns server, checks tools and `get_library_overview`|
| `pipeline` | Run `analyze` then `verify` in sequence                           |

## Output

The analyzer writes `component-metadata.json` to `./data/` inside this example directory. The cloned `components/` directory and the metadata output are both gitignored.
