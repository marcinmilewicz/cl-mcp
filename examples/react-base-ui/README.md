# Spike: React analyzer vs a real library (MUI Base UI)

End-to-end example running `@cl-mcp/analyzer` against **[Base UI](https://github.com/mui/base-ui)** — MUI's modern, TypeScript-first headless component library — then verifying the MCP server and the `cl-mcp` CLI over the result.

Base UI was chosen deliberately as a stress test: it uses `React.forwardRef(function X(...))` with namespace prop types (`CheckboxRoot.Props`), custom HOC factories (`fastComponent(...)`), and components that render exclusively through helpers (`return useRenderElement(...)`) with **no JSX literal in the body**.

> Why not MUI Material? Its sources are `.js` + PropTypes with separate `.d.ts` files — there is no TypeScript component source to analyze. The analyzer needs TS/TSX sources (see "Known limits").

## Run it

```bash
npm run example:react-setup   # build packages + npm install + sparse-clone Base UI + link @base-ui/utils
npm run example:react         # analyze + verify (metadata quality, MCP server, CLI)
```

The setup installs `react`/`@types/react` in this directory — the analyzer's TypeChecker resolves them by walking up from the cloned sources — and symlinks the in-repo `@base-ui/utils` package (its `exports` map points straight at `src/*.ts`).

## Spike results (Base UI `master`, 2026-07)

| Metric | Value |
|--------|-------|
| Components detected | **221** (785 source files), **198 with compound names** (`Dialog.Root`) |
| Components with props | 213 |
| Prop types resolved | **97%** (1119/1153; the rest are genuinely `any`-typed floating-ui props) |
| Callback props (`on*`) | 65 |
| Analysis time | ~1s |
| Hard patterns covered | `forwardRef(function X(...))`, `fastComponent(...)` factories, helper-rendered components (no JSX literal), namespace prop types, JSDoc + defaults |

Detection improvements that came out of this spike (all unit-tested):

1. **forwardRef/memo as a self-sufficient signal** — a wrapped exported PascalCase const is a component even when the render body has no JSX literal.
2. **Checker-based return-type fallback** — plain functions whose inferred return type is `ReactElement`/`ReactNode`/`JSX.Element` are components (catches `return useRenderDialogRoot(...)`-style rendering). Degrades gracefully when React types aren't installed.
3. **Unknown-factory unwrapping** — any call whose first argument is a function is looked through (`fastComponent(fn)`), but the inner function must still prove itself via JSX/return type; the factory alone proves nothing.
4. **Compound naming** — namespace barrels (`export * as Dialog from './index.parts'` + `export { DialogRoot as Root }`) rename components to their public form: entries and selectors are `Dialog.Root`, `className`/`exports` keep the internal `DialogRoot`. Both name forms resolve (`get DialogRoot` → `Dialog.Root`; exact normalized match beats substring, so `DialogRoot` is not ambiguous with `AlertDialog.Root`), and the JSX validator accepts both `<Dialog.Root>` and `<DialogRoot>`. Import hints render as `import { Dialog } from '@base-ui/react'`.

Without React types installed the pipeline still works, but drops to ~55% prop type resolution and misses helper-rendered components — hence the setup step.

## Known limits (honest)

- **`.js`-source libraries unsupported** — MUI Material's PropTypes-based `.js` components have no TS types to extract. Not planned; use libraries with TS sources.
- **A handful of `any` props** — Base UI genuinely types some floating-ui passthroughs as `any`; the analyzer reports them as unresolved rather than guessing.
- **`duplicate-component-name` diagnostics (5)** — Base UI defines a few component names in more than one file (overload files); first occurrence wins, surfaced as warnings.
- **No Storybook signal** — Base UI doesn't ship CSF stories in-repo, so `often-used-with` edges are absent here.
