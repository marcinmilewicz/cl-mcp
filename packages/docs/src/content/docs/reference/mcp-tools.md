---
title: MCP Tools
description: The six tools cl-mcp exposes to LLMs.
---

The MCP server and the CLI both route to the same six tool handlers in
`@cl-mcp/core`. Every tool accepts an optional `library` argument, and component
names accept `lib:Name` qualifiers (for example `ui:Button`).

## The six tools

### 1. `get_library_overview`
A compact reference for a library. In multi-library mode it renders per-library
sections. Good first call to orient an agent.

### 2. `find_components`
Search or browse components — semantic search when given a query, or a listing
when not. The resolver cascades exact → selector → fuzzy → semantic.

### 3. `get_component`
Detailed information for one component, at a chosen detail level: `api`, `full`,
`examples`, or `types`.

### 4. `get_components_batch`
The batch version of `get_component` — resolve and format several components in
one call.

### 5. `validate_template`
Validates **Angular** templates against the extracted component APIs. Refuses
React libraries and points to `validate_usage`.

### 6. `validate_usage`
Framework-dispatched validation: **JSX** for React libraries, **templates** for
Angular libraries.

## Validation model

Template validation parses each selector into per-comma clause matchers, so
compound-selector hosts (`button[mat-button]`, `[a],[b]` lists) are fully
validated: a binding is valid if **any** matched API declares it, and `:not(...)`
matches conservatively.

JSX validation flags unknown props and missing required props (with Levenshtein
suggestions), is spread-aware, and ignores unregistered/DOM elements. Prop
_values_ are not checked — use `get_component` for the allowed literal values.

### Angular validation requires @angular/compiler

Angular template validation needs the optional
[`@angular/compiler`](/guides/angular-compiler/) peer dependency. Without it,
the result is a single `angular-compiler-unavailable` error; React/JSX
validation is unaffected.

## Programmatic use

The handlers are exported from `@cl-mcp/core` as `TOOL_HANDLERS` (pure
`args → ToolResponse` functions with no SDK dependency). See the
[API Reference](/api/) for the exact signatures.
