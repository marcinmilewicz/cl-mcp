# Example: shadcn/ui-style components (in-repo)

shadcn/ui is **not a package** — its CLI copies component sources into your
repo (`components/ui/*.tsx`). That matches cl-mcp's core use case exactly: a
directory of components inside a monorepo analyzed as a library. This example
is a committed fixture written in the canonical shadcn style (button with cva
variants, Radix dialog wrappers, input), so it is deterministic — no upstream
clone to break.

## Run it

```bash
cd examples/react-shadcn
npm run setup      # npm install (react, @types/react, @radix-ui/react-dialog, cva)
npm run pipeline   # analyze + verify (metadata assertions + MCP server + CLI)
```

## What it pins (the patterns that matter for shadcn)

| Pattern | Result |
|---------|--------|
| `const Button = React.forwardRef(...); export { Button }` | detected (separate-`export{}` statement support) |
| `VariantProps<typeof buttonVariants>` (cva) | `variant` resolves to `default \| destructive \| outline \| secondary \| ghost \| link`, `size` to `default \| sm \| lg \| icon` — literal unions derived from the cva config object, not annotations |
| `React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>` | Radix-derived props surfaced on `DialogContent` |
| `extends React.ButtonHTMLAttributes<...>` | DOM props filtered out — `Button` reports only `asChild`, `variant`, `size` |
| `validate_usage` | `<Button variant="destructive">` passes; `<Button varaint=…>` rejected with a `variant` suggestion |

## Known limits (honest)

- **Plain re-export aliases are not components to the analyzer** —
  `const Dialog = DialogPrimitive.Root` (no function, no JSX) is skipped, so
  `Dialog`/`DialogTrigger`/`DialogPortal`/`DialogClose` don't appear; the
  styled wrappers (`DialogContent`, `DialogOverlay`, `DialogTitle`, …) do.
- Prop **values** are not validated (`variant="nonexistent"` passes) — the JSX
  validator checks prop names and required props; the resolved literal-union
  values are surfaced in `get_component` for the LLM to use.
