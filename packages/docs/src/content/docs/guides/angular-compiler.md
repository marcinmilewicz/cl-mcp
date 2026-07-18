---
title: Optional @angular/compiler
description: How the analyzer treats @angular/compiler as an optional peer dependency.
---

`@angular/compiler` is an **optional peer dependency** of `@cl-mcp/analyzer`.
React-only consumers of the pipeline never need it installed; it is required
only to **analyze Angular libraries** or **validate Angular templates**.

## Why it is optional

The compiler is only ever needed to parse Angular templates (for `ng-content`
slot detection, template validation, and Storybook used-component extraction).
Forcing every consumer — including React-only ones — to install it would be
dead weight. So the pipeline is built to import cleanly without it and to fail
loudly, with a clear message, only at the exact point a template is parsed.

## How it works

There is a single place in the codebase that loads `@angular/compiler`:
`src/shared/template-parser.ts`, via a guarded top-level `await import()`. Every
other module imports compiler **types only** (`import type`), which are erased
at compile time.

- All value access goes through `requireAngularCompiler()` — it returns the
  loaded module or throws `AngularCompilerUnavailableError`.
- `isAngularCompilerAvailable()` lets callers probe without throwing.

Because the load is guarded, importing `@cl-mcp/analyzer` — and anything that
transitively imports it, including `@cl-mcp/core` — never throws when the
package is absent. Only actually parsing an Angular template does.

## Behavior when it is absent

| Entry point | Behavior without `@angular/compiler` |
| --- | --- |
| Importing any package | Works — no throw at import time. |
| `AngularFrameworkAnalyzer.analyze()` | **Fails fast** with an install hint (`AngularCompilerUnavailableError`). |
| `TemplateValidator.validate()` | Returns a single `angular-compiler-unavailable` [validation error](/reference/mcp-tools/). |
| React analysis & JSX validation | **Unaffected.** |

The original load error is preserved in the message, so a version mismatch is
never misreported as "not installed".

## Installing it

```bash
npm i -D @angular/compiler
```

Any of the supported majors work: `^17.0.0 || ^18.0.0 || ^19.0.0 || ^20.0.0`.
