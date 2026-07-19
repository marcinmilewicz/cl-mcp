/**
 * Tests for the React AST analyzer core (component detection + prop
 * extraction) and the JSX validator.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createVirtualProgram } from "../../../test/fixtures/virtual-program.js";
import { DiagnosticsCollector } from "../../shared/diagnostics.js";
import { JsxValidator } from "./jsx-validator.js";
import { ReactAstAnalyzer, parseDeprecationText } from "./react-analyzer.js";

const TSX_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
};

function analyze(files: Record<string, string>, fileName: string) {
  const { program } = createVirtualProgram(files, TSX_OPTIONS);
  const analyzer = new ReactAstAnalyzer();
  analyzer.setDiagnostics(new DiagnosticsCollector());
  analyzer.setProgram(program);
  return analyzer.analyzeFile(fileName);
}

describe("ReactAstAnalyzer — component detection", () => {
  it("detects an exported function declaration component with JSX", () => {
    const result = analyze(
      {
        "/virt/Button.tsx": `
          type Props = { label: string };
          export function Button(props: Props) { return <button>{props.label}</button>; }
        `,
      },
      "/virt/Button.tsx",
    );
    expect(result.analysis.components).toHaveLength(1);
    expect(result.analysis.components[0].className).toBe("Button");
    expect(result.analysis.components[0].metadata.selector).toBe("Button");
    expect(result.analysis.components[0].metadata.standalone).toBe(true);
  });

  it("detects an arrow-function const component", () => {
    const result = analyze(
      {
        "/virt/Card.tsx": `
          export const Card = ({ title }: { title: string }) => <div>{title}</div>;
        `,
      },
      "/virt/Card.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["Card"]);
  });

  it("unwraps memo(forwardRef(...)) down to the render function", () => {
    const result = analyze(
      {
        "/virt/Input.tsx": `
          const memo = (x: any) => x;
          const forwardRef = (x: any) => x;
          export const Input = memo(forwardRef((props: { value: string }, ref: unknown) => <input value={props.value} />));
        `,
      },
      "/virt/Input.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["Input"]);
    expect(result.analysis.components[0].inputs.map((i) => i.name)).toEqual(["value"]);
  });

  it("detects a class component and reads props from the Component<P> generic", () => {
    const result = analyze(
      {
        "/virt/Legacy.tsx": `
          declare class Component<P> { props: P; }
          type Props = { mode: "compact" | "full" };
          export class Legacy extends Component<Props> {
            render() { return <div/>; }
          }
        `,
      },
      "/virt/Legacy.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["Legacy"]);
    const mode = result.analysis.components[0].inputs.find((i) => i.name === "mode");
    expect(mode?.resolvedValues).toEqual({ values: ["compact", "full"], partial: false });
  });

  it("detects a forwardRef-wrapped component with NO JSX in the body (helper-rendered)", () => {
    const result = analyze(
      {
        "/virt/Root.tsx": `
          const forwardRef = (x: any) => x;
          function useRenderElement(tag: string, props: unknown): unknown { return null; }
          export const CheckboxRoot = forwardRef(function CheckboxRoot(
            componentProps: { checked?: boolean; disabled: boolean },
            ref: unknown,
          ) {
            return useRenderElement("span", componentProps);
          });
        `,
      },
      "/virt/Root.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["CheckboxRoot"]);
    expect(result.analysis.components[0].inputs.map((i) => i.name).sort()).toEqual(["checked", "disabled"]);
  });

  it("unwraps an unknown factory (fastComponent-style) when the inner function has JSX", () => {
    const result = analyze(
      {
        "/virt/Fast.tsx": `
          const fastComponent = (fn: any) => fn;
          export const TooltipRoot = fastComponent(function TooltipRoot(props: { open?: boolean; disabled: boolean }) {
            return <span data-open={props.open} />;
          });
        `,
      },
      "/virt/Fast.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["TooltipRoot"]);
    expect(result.analysis.components[0].inputs.map((i) => i.name).sort()).toEqual(["disabled", "open"]);
  });

  it("does NOT detect an unknown factory whose inner function lacks any JSX signal", () => {
    const result = analyze(
      {
        "/virt/NotComp.tsx": `
          const makeThing = (fn: any) => fn;
          export const Registry = makeThing(function Registry(config: { key: string }) {
            return config.key.length;
          });
        `,
      },
      "/virt/NotComp.tsx",
    );
    expect(result.analysis.components).toHaveLength(0);
  });

  it("detects components published via a separate `export { Button }` statement (shadcn pattern)", () => {
    const result = analyze(
      {
        "/virt/button.tsx": `
          const forwardRef = (x: any) => x;
          const Button = forwardRef(({ variant, disabled }: { variant?: "default" | "ghost"; disabled: boolean }) => (
            <button disabled={disabled} data-variant={variant} />
          ));
          const buttonVariants = { default: "", ghost: "" };
          const helper = () => 1;
          export { Button, buttonVariants, helper };
        `,
      },
      "/virt/button.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["Button"]);
    expect(result.analysis.components[0].inputs.map((i) => i.name).sort()).toEqual(["disabled", "variant"]);
  });

  it("does NOT detect a non-exported component const", () => {
    const result = analyze(
      {
        "/virt/private.tsx": `
          const Internal = ({ x }: { x: number }) => <div>{x}</div>;
          export const usePublic = () => Internal;
        `,
      },
      "/virt/private.tsx",
    );
    expect(result.analysis.components).toHaveLength(0);
  });

  it("detects a plain function component via the checker return-type fallback", () => {
    const result = analyze(
      {
        "/virt/Dialog.tsx": `
          type ReactElement = { __el: true };
          function renderDialog(props: unknown): ReactElement { return { __el: true }; }
          export function DialogRoot(props: { open?: boolean; modal: boolean }) {
            return renderDialog(props);
          }
        `,
      },
      "/virt/Dialog.tsx",
    );
    expect(result.analysis.components.map((c) => c.className)).toEqual(["DialogRoot"]);
    expect(result.analysis.components[0].inputs.map((i) => i.name).sort()).toEqual(["modal", "open"]);
  });

  it("does NOT detect a PascalCase function returning a non-JSX type", () => {
    const result = analyze(
      {
        "/virt/Fmt.tsx": `
          export function Format(props: { x: string }) { return props.x.toUpperCase(); }
        `,
      },
      "/virt/Fmt.tsx",
    );
    expect(result.analysis.components).toHaveLength(0);
  });

  it("ignores lowercase functions and functions without JSX", () => {
    const result = analyze(
      {
        "/virt/util.tsx": `
          export function helper(x: number) { return x + 1; }
          export function BuildThing(x: number) { return x * 2; }
        `,
      },
      "/virt/util.tsx",
    );
    expect(result.analysis.components).toHaveLength(0);
  });
});

describe("ReactAstAnalyzer — prop extraction", () => {
  const buttonSource = `
    /** A clickable button. */
    export function Button({ variant = "primary", disabled, onClick, icon, children }: {
      /** Visual variant. */
      variant?: "primary" | "secondary" | "danger";
      /** Disables interaction. */
      disabled: boolean;
      onClick?: (event: { x: number }) => void;
      icon?: ReactNode;
      children?: ReactNode;
    }) { return <button disabled={disabled}>{icon}{children}</button>; }
    type ReactNode = string | number | null;
  `;

  it("extracts required/optional/default/description/union values", () => {
    const result = analyze({ "/virt/Button.tsx": buttonSource }, "/virt/Button.tsx");
    const component = result.analysis.components[0];

    const variant = component.inputs.find((i) => i.name === "variant");
    expect(variant?.required).toBe(false);
    expect(variant && "defaultValue" in variant && variant.defaultValue).toBe('"primary"');
    expect(variant?.description).toBe("Visual variant.");
    expect(variant?.resolvedValues).toEqual({ values: ["primary", "secondary", "danger"], partial: false });

    const disabled = component.inputs.find((i) => i.name === "disabled");
    expect(disabled?.required).toBe(true);
    expect(disabled?.type).toBe("boolean");
  });

  it("classifies /^on[A-Z]/ function props as outputs with the event type", () => {
    const result = analyze({ "/virt/Button.tsx": buttonSource }, "/virt/Button.tsx");
    const component = result.analysis.components[0];
    expect(component.outputs).toHaveLength(1);
    expect(component.outputs[0].name).toBe("onClick");
    expect(component.outputs[0].eventType).toBe("{ x: number; }");
    expect(component.inputs.find((i) => i.name === "onClick")).toBeUndefined();
  });

  it("maps children + ReactNode props to content slots (named slots stay inputs)", () => {
    const result = analyze({ "/virt/Button.tsx": buttonSource }, "/virt/Button.tsx");
    const slots = result.slots.get("Button") ?? [];
    expect(slots.map((s) => s.name).sort()).toEqual(["children", "icon"]);
    expect(slots.find((s) => s.name === "children")?.multiple).toBe(true);
    const component = result.analysis.components[0];
    expect(component.inputs.some((i) => i.name === "icon")).toBe(true);
    expect(component.inputs.some((i) => i.name === "children")).toBe(false);
  });

  it("reads props from a React.FC<P> annotation when there is no param annotation", () => {
    const result = analyze(
      {
        "/virt/Tag.tsx": `
          type FC<P> = (props: P) => unknown;
          type Props = { color: string };
          export const Tag: FC<Props> = (props) => <span style={{ color: props.color }} />;
        `,
      },
      "/virt/Tag.tsx",
    );
    const component = result.analysis.components[0];
    expect(component.inputs.map((i) => i.name)).toEqual(["color"]);
    expect(component.inputs[0].required).toBe(true);
  });

  it("marks mixed literal unions as partial", () => {
    const result = analyze(
      {
        "/virt/Mix.tsx": `
          type Custom = { brand: true };
          export function Mix({ tone }: { tone?: "light" | "dark" | Custom }) { return <div/>; }
        `,
      },
      "/virt/Mix.tsx",
    );
    const tone = result.analysis.components[0].inputs.find((i) => i.name === "tone");
    expect(tone?.resolvedValues?.partial).toBe(true);
    expect(tone?.resolvedValues?.values).toEqual(["light", "dark"]);
  });

  it("extracts component-level JSDoc description and @deprecated", () => {
    const result = analyze(
      {
        "/virt/Old.tsx": `
          /**
           * Old panel.
           * @deprecated since v2.1.0. Use Panel instead. Removed in v3.0.0.
           */
          export function OldPanel() { return <div/>; }
        `,
      },
      "/virt/Old.tsx",
    );
    const component = result.analysis.components[0];
    expect(component.jsDocDescription).toContain("Old panel");
    const deprecation = result.deprecations.get("OldPanel");
    expect(deprecation?.deprecated).toBe(true);
    expect(deprecation?.since).toBe("2.1.0");
    expect(deprecation?.removeIn).toBe("3.0.0");
    expect(deprecation?.replacement).toBe("Panel");
  });

  it("collects exported interfaces/types as exportedTypes", () => {
    const result = analyze(
      {
        "/virt/Types.tsx": `
          export interface ChipProps { label: string; count?: number; }
          export type Size = "s" | "m" | "l";
          export function Chip(props: ChipProps) { return <span>{props.label}</span>; }
        `,
      },
      "/virt/Types.tsx",
    );
    const kinds = result.analysis.exportedTypes.map((t) => `${t.kind}:${t.name}`).sort();
    expect(kinds).toEqual(["interface:ChipProps", "type:Size"]);
  });
});

describe("parseDeprecationText", () => {
  it("extracts since/removeIn/replacement via the shared regex heuristics", () => {
    const info = parseDeprecationText("since v1.2.3. Use NewThing instead. Removed in v2.0.0.");
    expect(info).toMatchObject({ deprecated: true, since: "1.2.3", removeIn: "2.0.0", replacement: "NewThing" });
  });
});

describe("JsxValidator", () => {
  function makeValidator() {
    const files = {
      "/virt/Button.tsx": `
        export function Button({ variant, disabled, onClick }: {
          variant?: "primary" | "secondary";
          disabled: boolean;
          onClick?: () => void;
        }) { return <button/>; }
      `,
    };
    const result = analyze(files, "/virt/Button.tsx");
    const validator = new JsxValidator();
    validator.registerFromAnalysis([result.analysis]);
    return validator;
  }

  it("accepts a valid usage", () => {
    const result = makeValidator().validate(`<Button disabled={true} variant="primary" onClick={() => {}} />`);
    expect(result.errors).toEqual([]);
  });

  it("flags an unknown prop with a Levenshtein suggestion", () => {
    const result = makeValidator().validate(`<Button disabled={true} varint="primary" />`);
    const error = result.errors.find((e) => e.type === "unknown-input");
    expect(error).toBeDefined();
    expect(error && "suggestion" in error && error.suggestion).toBe("variant");
  });

  it("flags a misspelled callback as unknown-output", () => {
    const result = makeValidator().validate(`<Button disabled onClik={() => {}} />`);
    const error = result.errors.find((e) => e.type === "unknown-output");
    expect(error && "suggestion" in error && error.suggestion).toBe("onClick");
  });

  it("flags missing required props", () => {
    const result = makeValidator().validate(`<Button variant="primary" />`);
    expect(
      result.errors.some((e) => e.type === "missing-required" && "property" in e && e.property === "disabled"),
    ).toBe(true);
  });

  it("skips required checks (with a note) when a spread is present", () => {
    const result = makeValidator().validate(`<Button {...props} />`);
    expect(result.errors).toEqual([]);
    expect(result.suggestions.some((s) => s.includes("spread"))).toBe(true);
  });

  it("ignores DOM tags and unregistered components", () => {
    const result = makeValidator().validate(`<div foo="bar"><Unknown x={1} /></div>`);
    expect(result.errors).toEqual([]);
  });

  it("validates multi-root snippets via fragment fallback", () => {
    const result = makeValidator().validate(`<Button disabled />\n<Button disabled />`);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
