---
title: Installation
description: Prerequisites and building the cl-mcp workspace.
---

## Prerequisites

- **Node.js ≥ 18** (the project is developed on Node 24)
- **npm** (the repo uses npm workspaces)
- **`@angular/compiler`** — an _optional_ peer dependency of `@cl-mcp/analyzer`,
  required only to analyze Angular libraries or validate Angular templates.
  React-only setups can skip it. See
  [Optional @angular/compiler](/guides/angular-compiler/).

## Clone & build

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
