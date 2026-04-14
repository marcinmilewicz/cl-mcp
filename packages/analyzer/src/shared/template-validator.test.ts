import { describe, expect, it } from "vitest";
import type { ComponentAnalysis, FileAnalysis, InputProperty, OutputProperty } from "../types.js";
import { asClassName, asFilePath, asSelector } from "../types.js";
import { DiagnosticsCollector } from "./diagnostics.js";
import { TemplateValidator } from "./template-validator.js";

/**
 * Build a minimal `FileAnalysis` that exercises only the fields the validator
 * consumes. All other readonly arrays are empty — this is faster than wiring
 * the full Angular AST analyzer on every test.
 */
function analysisWith(
  components: Array<{
    className: string;
    selector: string;
    inputs?: Array<Partial<InputProperty> & { name: string }>;
    outputs?: Array<Partial<OutputProperty> & { name: string }>;
  }>,
  directives: Array<{
    className: string;
    selector: string;
    inputs?: Array<Partial<InputProperty> & { name: string }>;
    outputs?: Array<Partial<OutputProperty> & { name: string }>;
  }> = [],
): FileAnalysis {
  const toComponent = (c: (typeof components)[number]): ComponentAnalysis => ({
    className: asClassName(c.className),
    filePath: asFilePath(`${c.className}.ts`),
    metadata: { selector: asSelector(c.selector), standalone: true },
    inputs: (c.inputs ?? []).map((i) => ({
      name: i.name,
      type: i.type ?? "string",
      typeResolved: i.typeResolved ?? true,
      required: (i.required ?? false) as false,
      resolvedValues: null,
      ...(i.required ? {} : { defaultValue: i.defaultValue }),
    })) as readonly InputProperty[],
    outputs: (c.outputs ?? []).map((o) => ({
      name: o.name,
      eventType: o.eventType ?? "void",
      eventTypeResolved: o.eventTypeResolved ?? true,
    })) as readonly OutputProperty[],
    publicMethods: [],
    dependencies: [],
    lifecycleHooks: [],
    exportedTypes: [],
  });

  return {
    filePath: asFilePath("test.ts"),
    components: components.map(toComponent),
    directives: directives.map(toComponent),
    pipes: [],
    services: [],
    exportedTypes: [],
    exportedFunctions: [],
  };
}

describe("TemplateValidator (AST-based)", () => {
  it("flags unknown input on a plain element, keeps known ones silent", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "Angular Material" });
    v.registerFromAnalysis([
      analysisWith([
        {
          className: "MatButton",
          selector: "mat-button",
          inputs: [{ name: "color" }, { name: "disabled", type: "boolean" }],
        },
      ]),
    ]);

    const result = v.validate('<mat-button [color]="primary" [bogus]="x"></mat-button>');
    const unknownInputs = result.errors.filter((e) => e.type === "unknown-input");
    expect(unknownInputs).toHaveLength(1);
    expect(unknownInputs[0].property).toBe("bogus");
  });

  it("dedupes two-way [(ngModel)] bindings: no spurious `ngModelChange` output error", () => {
    const v = new TemplateValidator();
    v.registerFromAnalysis([
      analysisWith([
        {
          className: "MyInput",
          selector: "my-input",
          // Include ngModel as known so the two-way binding is fully accepted
          // without triggering `unknown-input`.
          inputs: [{ name: "ngModel" }],
          outputs: [{ name: "ngModelChange" }],
        },
      ]),
    ]);

    const result = v.validate('<my-input [(ngModel)]="value"></my-input>');
    // Paired `ngModelChange` output must not be reported as spurious.
    expect(result.errors.filter((e) => e.type === "unknown-output")).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("descends into @if blocks (regex missed this)", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "test" });
    v.registerFromAnalysis([
      analysisWith([{ className: "MatButton", selector: "mat-button", inputs: [{ name: "color" }] }]),
    ]);

    const tmpl = '@if (x) { <mat-button [invalidInput]="y"></mat-button> }';
    const result = v.validate(tmpl);
    const unknown = result.errors.filter((e) => e.type === "unknown-input");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].property).toBe("invalidInput");
  });

  it("descends into @for blocks", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "test" });
    v.registerFromAnalysis([
      analysisWith([{ className: "MatButton", selector: "mat-button", inputs: [{ name: "color" }] }]),
    ]);

    const tmpl = '@for (item of items; track item) { <mat-button [nope]="item"></mat-button> }';
    const result = v.validate(tmpl);
    expect(result.errors.some((e) => e.type === "unknown-input" && e.property === "nope")).toBe(true);
  });

  it("descends into legacy *ngIf / *ngFor (TmplAstTemplate path)", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "test" });
    v.registerFromAnalysis([
      analysisWith([{ className: "MatButton", selector: "mat-button", inputs: [{ name: "color" }] }]),
    ]);

    const r1 = v.validate('<mat-button *ngIf="flag" [invalidOne]="x"></mat-button>');
    expect(r1.errors.some((e) => e.type === "unknown-input" && e.property === "invalidOne")).toBe(true);

    const r2 = v.validate('<mat-button *ngFor="let i of items" [invalidTwo]="i"></mat-button>');
    expect(r2.errors.some((e) => e.type === "unknown-input" && e.property === "invalidTwo")).toBe(true);
  });

  it("recognizes attribute directives (mat-button, matTooltip) via directiveAttrs", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "test" });
    v.registerFromAnalysis([
      analysisWith(
        [
          // `button` is a native HTML tag; it won't appear in componentAPIs.
          // The template uses `<button mat-button matTooltip="…">`.
        ],
        [
          { className: "MatButton", selector: "[mat-button]" },
          {
            className: "MatTooltip",
            selector: "[matTooltip]",
            inputs: [{ name: "matTooltip" }, { name: "matTooltipPosition" }],
          },
        ],
      ),
    ]);

    // Plain HTML element with attribute directives — should NOT error on
    // `mat-button` / `matTooltip` since they're registered directive
    // selectors. (No componentAPI for `button` → element is skipped, but
    // the validator also must not spuriously error on attrs.)
    const result = v.validate('<button mat-button matTooltip="hi"></button>');
    expect(result.errors).toHaveLength(0);
  });

  it("emits pipe-arg-count-mismatch warning for too-many date args", () => {
    const v = new TemplateValidator();
    v.registerFromAnalysis([analysisWith([{ className: "C", selector: "c-el", inputs: [{ name: "label" }] }])]);

    const result = v.validate(`<c-el label="{{ x | date:'short':'UTC':'extra' }}"></c-el>`);
    const warn = result.warnings.find((w) => w.type === "pipe-arg-count-mismatch");
    expect(warn).toBeDefined();
    expect(warn?.property).toBe("date");
  });

  it("emits template-parse-failed diagnostic on malformed input (partial recovery)", () => {
    const diagnostics = new DiagnosticsCollector();
    const v = new TemplateValidator({ diagnostics });
    // Unterminated attribute triggers parser errors but recovers some nodes.
    const result = v.validate('<div [x="unclosed');
    const ds = diagnostics.all();
    expect(ds.some((d) => d.code === "template-parse-failed")).toBe(true);
    expect(ds.every((d) => d.severity === "warn")).toBe(true);
    // Partial recovery: result shape is still the standard {errors, warnings, suggestions}.
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("populates sourceSpan on at least one error (shape: {line, column, length})", () => {
    const v = new TemplateValidator({ selectorPrefix: "mat-", libraryName: "test" });
    v.registerFromAnalysis([
      analysisWith([{ className: "MatButton", selector: "mat-button", inputs: [{ name: "color" }] }]),
    ]);

    const result = v.validate('\n\n<mat-button [wrongOne]="x"></mat-button>');
    const err = result.errors.find((e) => e.type === "unknown-input" && "property" in e && e.property === "wrongOne");
    expect(err).toBeDefined();
    if (err && "sourceSpan" in err && err.sourceSpan) {
      expect(typeof err.sourceSpan.line).toBe("number");
      expect(typeof err.sourceSpan.column).toBe("number");
      expect(typeof err.sourceSpan.length).toBe("number");
      // Binding is on line 3 (0-indexed lines in @angular/compiler → line 2).
      expect(err.sourceSpan.line).toBeGreaterThanOrEqual(1);
    } else {
      throw new Error("expected sourceSpan on unknown-input error");
    }
  });
});
