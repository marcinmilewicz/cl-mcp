---
title: cl-mcp CLI
description: The shell adapter over core, for agents, CI and humans.
---

`@cl-mcp/cli` is a thin shell adapter over `@cl-mcp/core` — the same tool
handlers as the MCP server, exposed as a `cl-mcp` binary. Use it for agents
without an MCP client, in CI, or interactively.

```bash
npx -y @cl-mcp/cli <command> [options]
```

Everything below shows `npx -y @cl-mcp/cli …`. If you install the package
globally (`npm i -g @cl-mcp/cli`), invoke it as the bare `cl-mcp` bin instead.

## Two-level, LLM-oriented help

The CLI ships help written for agents to read:

- `cl-mcp --help` — the recommended workflow plus the output and exit-code
  contract.
- `cl-mcp help <command>` / `cl-mcp <command> --help` — example-driven
  per-command help with usage semantics.

## Common commands

```bash
# list every loaded library
npx -y @cl-mcp/cli list-libraries --data-dir ./data

# fetch one component (lib:Name qualifier supported)
npx -y @cl-mcp/cli get ui:Button --data-dir ./data

# validate usage (JSX for React, template for Angular)
npx -y @cl-mcp/cli validate \
  --components Dialog.Root \
  --code '<Dialog.Root defaultOpen={true} />'
```

## Data source

Like the server, the CLI reads metadata from `--data-dir` (a directory of
per-library metadata) or a single metadata file. The same resolution rules and
`lib:Name` qualifiers apply.

:::tip
Because the CLI and MCP server share `TOOL_HANDLERS`, anything you can do with a
tool over MCP you can reproduce from the shell — handy for scripting and for
reproducing an agent's exact call in CI.
:::
