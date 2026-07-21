# @cl-mcp/core

Transport-agnostic core of [cl-mcp](https://github.com/marcinmilewicz/cl-mcp) — the
shared engine behind the MCP server and the CLI.

It owns everything except the transport:

- **Metadata loading** — a multi-library registry with a Zod trust boundary
  (`CL_MCP_METADATA_PATH` = single library, `CL_MCP_DATA_DIR` = a directory of
  libraries).
- **Search & resolution domain** — semantic search plus a name-resolution
  cascade (exact → selector → fuzzy → semantic), with compound-name support
  (`Dialog.Root`).
- **Tool handlers** — the six tools as pure `args → ToolResponse` functions
  (`TOOL_HANDLERS`), with no SDK dependency.

Importing this package has **no side effects**; call `loadPreloadedMetadata()`
before using any accessor or handler.

## Install

```bash
npm install @cl-mcp/core @cl-mcp/analyzer
```

`@cl-mcp/analyzer` is a peer dependency (it provides the shared metadata types
and analysis primitives).

## Frontends

Both official frontends are thin adapters over this package and re-use the exact
same handlers:

- [`@cl-mcp/mcp-server`](https://www.npmjs.com/package/@cl-mcp/mcp-server) — MCP protocol (stdio) adapter.
- [`@cl-mcp/cli`](https://www.npmjs.com/package/@cl-mcp/cli) — shell adapter (`cl-mcp` bin).

See the [documentation site](https://marcinmilewicz.github.io/cl-mcp/) and the
[API reference](https://marcinmilewicz.github.io/cl-mcp/api/) for details.

## License

MIT © Marcin Milewicz
