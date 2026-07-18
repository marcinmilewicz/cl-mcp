---
title: Multi-Library Workspaces
description: Analyzing many libraries at once with cl-mcp.yaml.
---

A real design system is rarely a single package. `cl-mcp` analyzes an entire
workspace of libraries in one run, emitting per-library metadata plus a manifest
that ties them together.

## cl-mcp.yaml

The workspace layer (`src/workspace/`) is configured with a Zod-validated
`cl-mcp.yaml`. Each library entry names a path and (optionally) a framework; the
framework detector infers it from dependencies and a source scan when omitted.

```bash
node packages/analyzer/dist/cli/generate-metadata.js --config ./cl-mcp.yaml
```

You can also skip the config file entirely:

```bash
# explicit library paths
node packages/analyzer/dist/cli/generate-metadata.js \
  --lib libs/ui --lib libs/forms --output-dir ./data

# or scan a directory for libraries
node packages/analyzer/dist/cli/generate-metadata.js --scan libs --output-dir ./data
```

## Library discovery

Discovery is **not** coupled to any particular monorepo tool. It combines
explicit entries and scan directories, and resolves each library's alias from,
in order: `tsconfig` path mappings → `package.json` name → the relative path.

## Outputs

- `data/<library>/component-metadata.json` — one per library.
- `data/workspace-manifest.json` — every library, plus the cross-library import
  graph and Storybook co-occurrence data used for related-component suggestions.

## Serving a workspace

Point the server or CLI at the directory and every library is loaded:

```bash
CL_MCP_DATA_DIR=./data node packages/mcp-server/dist/index.js
node packages/cli/dist/index.js list-libraries --data-dir ./data
```

Every tool accepts an optional `library` argument, and component names accept
`lib:Name` qualifiers (for example `ui:Button`) so the same request can target
any library in the workspace.

## Mixed frameworks

Workspaces can mix frameworks freely. The committed `examples/multi-framework/`
fixture is deliberately two different layouts — `libs/ui` (React, flat) and
`libs/forms` (Angular, directory-per-component) — so the pipeline is exercised
against both at once:

```bash
npm run example:multi
```
