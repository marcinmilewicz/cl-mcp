---
title: Quick Start
description: Generate metadata for a library and serve it over MCP or the CLI.
---

This walkthrough uses the published npm packages via `npx` — you only need
[Node.js ≥ 18](/getting-started/installation/), no clone or build.

## 1. Generate metadata

### A single library

```bash
npx -y @cl-mcp/cli generate \
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

:::note
Analyzing **Angular** libraries needs the optional `@angular/compiler` peer,
which an isolated `npx` run won't have. Run from a project where it's installed,
or co-install it: `npx -y -p @cl-mcp/cli -p @angular/compiler cl-mcp generate --framework angular …`.
React needs nothing extra.
:::

### A multi-library workspace

Describe your libraries in a `cl-mcp.yaml` (or pass them ad hoc), and the
analyzer emits per-library metadata plus a `workspace-manifest.json` with a
cross-library import graph:

```bash
# from a config file
npx -y @cl-mcp/cli generate --config ./cl-mcp.yaml

# explicit libraries
npx -y @cl-mcp/cli generate \
  --lib libs/ui --lib libs/forms --output-dir ./data

# scan a directory
npx -y @cl-mcp/cli generate --scan libs --output-dir ./data
```

## 2a. Run the MCP server

```bash
# single library
CL_MCP_METADATA_PATH=./data/angular-material/component-metadata.json \
  npx -y @cl-mcp/mcp-server

# every library in a directory
CL_MCP_DATA_DIR=./data npx -y @cl-mcp/mcp-server
```

The server speaks MCP over stdio and exposes [six tools](/reference/mcp-tools/).

### Connect it to an MCP client

Point your client at the same command. For Claude Code
(`~/.claude/mcp_servers.json`) — use absolute paths for the data directory:

```json
{
  "cl-mcp": {
    "command": "npx",
    "args": ["-y", "@cl-mcp/mcp-server"],
    "env": {
      "CL_MCP_DATA_DIR": "/absolute/path/to/data"
    }
  }
}
```

For Cursor, VS Code (Continue), or any MCP-compatible client, add the same
`command`, `args`, and `env` to its server config.

## 2b. Or use the CLI

For agents without an MCP client, for CI, or for humans:

```bash
npx -y @cl-mcp/cli list-libraries --data-dir ./data
npx -y @cl-mcp/cli get ui:Button --data-dir ./data
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
