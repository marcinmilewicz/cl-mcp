# Example: NG-ZORRO (Ant Design for Angular)

Second real-world **Angular** target (pinned to tag `21.3.2`), validating that
the Angular pipeline generalizes beyond the Angular Material conventions it
grew up on: `@WithConfig()` global configuration, attribute selectors
(`button[nz-button]`), heavy inline templates with content projection, and the
`nz-` prefix.

## Run it

```bash
# from the repo root (packages must be built):
cd examples/ng-zorro
npm run setup      # sparse-clone NG-ZORRO at the pinned tag
npm run pipeline   # analyze + verify (quality floors + MCP server)
```

Override the pin with `NG_ZORRO_REF=<tag> npm run setup`.

## Results (tag 21.3.2)

| Metric | Value |
|--------|-------|
| Components | 83 |
| Selector mappings | 1044 |
| `@WithConfig()` components | 34 (123 config-driven inputs, e.g. `button` → `nzSize`) |
| Diagnostics | 0 errors, 11 warnings (8× `inheritance-unresolved-import`, 3× `empty-selector`) |
| Analysis time | ~1s (1605 source files) |

Representative check pinned by the verify script: `NzButtonComponent.nzType`
resolves its literal union **through the `NzButtonType` alias**
(`'default' | 'primary' | 'dashed' | 'link' | 'text'`) — the TypeChecker path,
not text matching. Template validation catches typo'd inputs on plain element
selectors (`<nz-alert nzTyppe=…>` → rejected).

`@WithConfig()` decorated inputs are modeled as config tokens
(`kind: "with-config"`): the config key resolves through
`_nzModuleName`/`NZ_CONFIG_MODULE_NAME`, properties are the decorated inputs
with their defaults, and `get_component --detail full` renders the
`provideNzConfig({ button: { … } })` usage snippet.
