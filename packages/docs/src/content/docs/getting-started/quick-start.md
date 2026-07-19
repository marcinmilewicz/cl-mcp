---
title: Quick Start
description: Generate metadata for a library and serve it over MCP or the CLI.
---

This walkthrough assumes you have already [built the workspace](/getting-started/installation/)
(`npm run build`).

## 1. Generate metadata

### A single library

```bash
node packages/analyzer/dist/cli/generate-metadata.js \
  --framework angular \
  --path <library-path> \
  --package <name> \
  [--prefix <selector-prefix>] \
  [--storybook <path>] \
  [--docs <path>] \
  [--output <path>]
```

Use `--framework react` for React libraries. The command writes one
`component-metadata.json`.

### A multi-library workspace

Describe your libraries in a `cl-mcp.yaml` (or pass them ad hoc), and the
analyzer emits per-library metadata plus a `workspace-manifest.json` with a
cross-library import graph:

```bash
# from a config file
node packages/analyzer/dist/cli/generate-metadata.js --config ./cl-mcp.yaml

# explicit libraries
node packages/analyzer/dist/cli/generate-metadata.js \
  --lib libs/ui --lib libs/forms --output-dir ./data

# scan a directory
node packages/analyzer/dist/cli/generate-metadata.js --scan libs --output-dir ./data
```

## 2a. Run the MCP server

```bash
# single library
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json \
  node packages/mcp-server/dist/index.js

# every library in a directory
CL_MCP_DATA_DIR=./data node packages/mcp-server/dist/index.js
```

The server speaks MCP over stdio and exposes [six tools](/reference/mcp-tools/).

## 2b. Or use the CLI

For agents without an MCP client, for CI, or for humans:

```bash
node packages/cli/dist/index.js list-libraries --data-dir ./data
node packages/cli/dist/index.js get ui:Button --data-dir ./data
```

Run `cl-mcp --help` for the recommended workflow and the output/exit-code
contract, and `cl-mcp help <command>` for example-driven per-command help.

## 3. Explore the examples

The repository ships runnable examples that exercise the full pipeline:

```bash
npm run example:multi     # mixed React + Angular workspace (committed fixture)
npm run example:setup && npm run example:run   # Angular Material (fetched on setup)
```

See the [Pipeline guide](/guides/pipeline/) for what each stage does.
