---
title: Installation
description: Prerequisites and building the cl-mcp workspace.
---

## Prerequisites

- **Node.js ≥ 18** (the project is developed on Node 24)
- **npm** (ships with Node; `npx` is used to run the tools)
- **`@angular/compiler`** — an _optional_ peer dependency of `@cl-mcp/analyzer`,
  required only to analyze Angular libraries or validate Angular templates.
  React-only setups can skip it. See
  [Optional @angular/compiler](/guides/angular-compiler/).

## Use it from npm (recommended)

The three runnable packages are published to npm as bins — run them with
`npx`, no clone or build required:

| Command | Package | What it does |
| --- | --- | --- |
| `npx -y @cl-mcp/cli …` | `@cl-mcp/cli` | The `cl-mcp` CLI (query + `generate`). |
| `npx -y @cl-mcp/mcp-server` | `@cl-mcp/mcp-server` | The MCP server over stdio. |

```bash
# generate metadata, then serve or query it
npx -y @cl-mcp/cli generate --config ./cl-mcp.yaml
CL_MCP_DATA_DIR=./data npx -y @cl-mcp/mcp-server
npx -y @cl-mcp/cli list-libraries --data-dir ./data
```

See [Quick Start](/getting-started/quick-start/) for the full walkthrough.

:::note
Analyzing **Angular** libraries needs the optional `@angular/compiler` peer,
which an isolated `npx` run won't have. Run `generate` from a project where
`@angular/compiler` is installed, or co-install it for the run:
`npx -y -p @cl-mcp/cli -p @angular/compiler cl-mcp generate --framework angular …`.
:::

## Develop cl-mcp from source

Only needed to work on cl-mcp itself (not to use it):

### Clone & build

```bash
git clone https://github.com/marcinmilewicz/cl-mcp.git
cd cl-mcp
npm install
npm run build   # builds analyzer → core → mcp-server → cli, in order
```

## Verify

```bash
npm test        # run the full test suite (vitest)
npm run lint    # biome
```

## Repository scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Build all packages in dependency order. |
| `npm test` | Run all tests via vitest. |
| `npm run lint` / `npm run lint:fix` | Lint / auto-fix with Biome. |
| `npm run clean` | Remove `dist/` from all packages. |
| `npm run docs:dev` | Run this documentation site locally. |
| `npm run docs:build` | Build the packages, then the docs site (with the TypeDoc API reference). |

:::note
The documentation build runs `npm run build` first so TypeDoc can resolve the
cross-package `@cl-mcp/*` type imports from each package's compiled `dist`.
:::
