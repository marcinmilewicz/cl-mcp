# `@cl-mcp/cli` — MCP tools over the shell

Command-line access to component library metadata. A thin shell adapter over
`@cl-mcp/core`: every query command calls the **exact same tool handlers**
the MCP server dispatches to, so CLI and MCP output can never drift. Designed
for LLM agents with shell access — no MCP client required — as much as for
humans.

## Commands

```bash
cl-mcp generate --config ./cl-mcp.yaml     # run the analyzer (forwards to cl-mcp-analyze)
cl-mcp list-libraries [--json]             # loaded libraries + frameworks
cl-mcp overview [--library ui] [--json]    # quick reference (per-library sections when unscoped)
cl-mcp find "date picker" [--library ui]   # semantic search; no query = list all [--list-all]
cl-mcp get Button forms:input [--detail api|full|examples|types]
cl-mcp validate --components Button --code '<Button disabled={true} />'
cl-mcp validate --components input --file snippet.html   # or pipe via stdin
```

`validate` dispatches by the library's framework: JSX validation for React
libraries, Angular template validation for Angular libraries. Component names
accept a `lib:Name` qualifier on multi-library data, and React compound names
work in both forms — `cl-mcp get Dialog.Root` and `cl-mcp get DialogRoot`
reach the same component; `validate` accepts both `<Dialog.Root>` and
`<DialogRoot>` tags.

## Contract

- **stdout** — results (markdown by default, JSON via `--json`)
- **stderr** — logs and diagnostics
- **exit codes** — `0` ok, `1` tool rejected (validation errors, unknown component), `2` operational error (bad usage, missing metadata)

## Metadata resolution

1. `--metadata <path>` — a single `component-metadata.json`
2. `--data-dir <path>` — a directory of per-library metadata (multi-library)
3. `CL_MCP_METADATA_PATH` / `CL_MCP_DATA_DIR` environment variables
4. `cl-mcp.yaml`'s `outputDir` (config discovered upward from cwd)
5. `./data` convention relative to the monorepo root

## Agent workflow

The recommended flow mirrors the MCP tools: `overview` → `find` → `get` →
`validate` before emitting any component code. Example:

```bash
cl-mcp get Button --detail api          # ground the API before writing JSX
cl-mcp validate --components Button --code '<Button disabled={true} variant="primary" />'
echo $?                                  # 0 → safe to return the snippet
```
