# angular-material examples

- Before using any `<mat-*>` component, call the cl-mcp tool `get_component` to verify its real inputs/outputs. Do not invent props.
- After generating or editing any Angular template (inline `template:` or `.html`), call the cl-mcp tool `validate_template` on it and fix any reported issues before reporting the task as done.
- Angular 17+ standalone components with signals and `OnPush`. No NgModules.
