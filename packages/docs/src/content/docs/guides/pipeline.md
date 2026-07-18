---
title: The Pipeline
description: How source becomes metadata becomes LLM tools.
---

`cl-mcp` is a straight, one-directional pipeline. Understanding the four stages
makes the whole system easy to reason about.

```
analyzer CLI → component-metadata.json (+ workspace-manifest.json) → server / CLI → LLM tools
```

## Stage 1 — Analysis (build time)

The analyzer reads TypeScript/TSX source with the TypeScript compiler API and
produces framework-agnostic metadata.

- **Angular** (`analyzers/angular/`) — components, directives, pipes, services,
  inputs, outputs, inheritance, content projection, deprecation and config
  tokens, driven by a `ts.Program` for full type resolution.
- **React** (`analyzers/react/`) — function/arrow/class components (including
  `memo`/`forwardRef`/`React.FC<P>` and custom factories), props via the
  TypeChecker (required/defaults/literal unions/JSDoc), `/^on[A-Z]/` callbacks
  as outputs, `children`/`ReactNode` props as slots, and compound naming
  (`Dialog.Root`) from namespace barrels.

Both implement the same `FrameworkAnalyzer` interface and emit the same shapes.

## Stage 2 — Metadata artifacts

Each library becomes one `component-metadata.json`. In multi-library mode a
`workspace-manifest.json` records every library plus the cross-library import
graph. These files are the contract between build time and serve time.

## Stage 3 — Loading (serve time)

`@cl-mcp/core`'s data layer loads **every** resolvable metadata file into a
registry keyed by library name, behind a Zod trust boundary. Domain code reads
one "active" library at a time; handlers switch it per request. Paths resolve
from `CL_MCP_METADATA_PATH` (single) or `CL_MCP_DATA_DIR` (all subdirectories) —
a single file means single-library mode, fully backward compatible.

## Stage 4 — Tools

The [six tools](/reference/mcp-tools/) are pure `args → ToolResponse` functions
in core (`TOOL_HANDLERS`). The [MCP server](/reference/mcp-tools/) and the
[CLI](/reference/cli/) are thin adapters that route to the exact same handlers —
no domain logic is duplicated between them.

## Design principle: no hardcoded library values

Nothing library-specific (selector prefix, package name, framework) is hardcoded
in core or the server. It is all derived from the loaded metadata at runtime, so
adding a library never means touching the serving code.
