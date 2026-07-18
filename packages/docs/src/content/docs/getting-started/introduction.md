---
title: Introduction
description: What cl-mcp is, its four packages, and how the pipeline fits together.
---

`cl-mcp` is a monorepo that provides an **MCP (Model Context Protocol) server for
component library metadata**. It parses TypeScript/TSX source from Angular and
React component libraries at build time and exposes the extracted metadata to
LLMs through a small set of well-defined tools.

## The four packages

| Package | Role |
| --- | --- |
| **`@cl-mcp/analyzer`** | Build-time AST analysis of component libraries (Angular & React). Extracts inputs/props, outputs/callbacks, selectors/JSX names, inheritance, content projection, config tokens, deprecation, Storybook examples and import graphs. Outputs one `component-metadata.json` per library plus a `workspace-manifest.json` in multi-library mode. |
| **`@cl-mcp/core`** | Transport-agnostic core: metadata loading (multi-library registry + Zod trust boundary), the search/resolution domain, and the tool handlers (pure `args → ToolResponse` functions). Importing it has no side effects. |
| **`@cl-mcp/mcp-server`** | Thin MCP protocol (stdio) adapter over core: registers the tool schemas, routes `tools/call` to core's handlers, serves per-library quick-reference resources. |
| **`@cl-mcp/cli`** | Thin shell adapter over core: the `cl-mcp` bin with the same tool handlers, for agents without an MCP client, for CI, and for humans. |

## The pipeline

```
analyzer CLI
  → component-metadata.json (per library) + workspace-manifest.json
    → MCP server / cl-mcp CLI
      → LLM tools
```

The analyzer runs once at build time. The server and CLI are thin, side-effect-free
adapters over `@cl-mcp/core`, which owns all domain logic — neither frontend
re-implements search, resolution or formatting.

## One shape for two frameworks

The React analyzer deliberately emits the **same** `FileAnalysis` / `ComponentAnalysis`
structures as Angular — the JSX name becomes the `selector`, props become `inputs`,
and `/^on[A-Z]/` callbacks become `outputs`. Everything downstream (registry,
search, formatters, most validation) is framework-agnostic; only example rendering
and validation dispatch branch per framework.

## Where to go next

- [Installation](/getting-started/installation/) — prerequisites and building the workspace.
- [Quick Start](/getting-started/quick-start/) — generate metadata and run the server.
- [The Pipeline](/guides/pipeline/) — a deeper look at each stage.
