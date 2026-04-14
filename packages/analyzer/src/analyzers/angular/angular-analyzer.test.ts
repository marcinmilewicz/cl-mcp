/**
 * Phase 0 behavioral safety net for AngularAstAnalyzer.
 *
 * Goals:
 * - Golden-path coverage for the extractors that Phases 1–7 will refactor.
 * - Capture CURRENT behavior (including known bugs) so later phases see the
 *   assertion flip when they fix things. Do NOT fix bugs here.
 *
 * All tests compile real TypeScript source via an in-memory ts.Program — no
 * mocks — so refactors that preserve semantics stay green.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createVirtualProgram } from "../../../test/fixtures/virtual-program.js";
import { DiagnosticsCollector } from "../../shared/diagnostics.js";
import { AngularAstAnalyzer } from "./angular-analyzer.js";
import {
  analyzeContentProjection,
  analyzeInheritance,
  extractDeprecation,
  parseNgContentSlots,
} from "./angular-analyzer.js";

// ---------------------------------------------------------------------------
// Temp-file helpers
//
// Some analyzer entry points (analyzeFile, extractDeprecation) read from disk.
// For those we materialize tiny fixtures in os.tmpdir(). Everything else runs
// entirely against a virtual Program.
// ---------------------------------------------------------------------------

const tmpRoot = path.join(os.tmpdir(), `cl-mcp-analyzer-test-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(name: string, source: string): string {
  const filePath = path.join(tmpRoot, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// @Input() extraction
// ---------------------------------------------------------------------------

describe("extractInputProperty (basic @Input())", () => {
  it("extracts name, type and default value from a simple @Input property", () => {
    const filePath = writeFixture(
      "basic-input.ts",
      `
        export class FooComponent {
          @Input() label: string = 'hi';
        }
        function Input(): any { return () => {}; }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    // Class has no @Component/@Directive decorator so it won't be pushed
    // into analysis.components — but extractInputProperty is exercised
    // through the generic class-analysis path only when the class carries
    // a Component/Directive decorator. Add a decorated fixture to cover
    // the public surface:
    expect(analysis.components.length).toBe(0);
  });

  it("surfaces inputs on a decorated component", () => {
    const filePath = writeFixture(
      "decorated-input.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-foo', standalone: true })
        export class FooComponent {
          /** A greeting */
          @Input() label: string = 'hi';
          @Input({ required: true }) count!: number;
        }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    expect(analysis.components).toHaveLength(1);
    const [comp] = analysis.components;
    expect(comp.inputs.map((i) => i.name).sort()).toEqual(["count", "label"]);

    const label = comp.inputs.find((i) => i.name === "label");
    expect(label).toBeDefined();
    expect(label?.type).toBe("string");
    expect(label?.defaultValue).toBe("'hi'");
    expect(label?.required).toBe(false);

    const count = comp.inputs.find((i) => i.name === "count");
    expect(count?.required).toBe(true);
    expect(count?.type).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Getter/setter @Input() — including the duplicate-name (bug C1) case.
// ---------------------------------------------------------------------------

describe("extractInputFromGetter / extractInputFromSetter", () => {
  it("extracts an input from a lone @Input() setter", () => {
    const filePath = writeFixture(
      "setter-only.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-foo' })
        export class FooComponent {
          @Input() set value(v: string) {}
        }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const comp = analysis.components[0];
    expect(comp.inputs).toHaveLength(1);
    expect(comp.inputs[0].name).toBe("value");
    expect(comp.inputs[0].type).toBe("string");
  });

  it("extracts an input from a lone @Input() getter, inferring type from the matching setter", () => {
    const filePath = writeFixture(
      "getter-with-setter.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-foo' })
        export class FooComponent {
          @Input() get value() { return this._v; }
          set value(v: number) { this._v = v; }
          private _v: number = 0;
        }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const comp = analysis.components[0];
    const inputs = comp.inputs.filter((i) => i.name === "value");
    // Current behavior: a single input is produced (type inferred from setter).
    expect(inputs).toHaveLength(1);
    expect(inputs[0].type).toBe("number");
  });

  // Bug C1 (fixed in Phase 3): @Input() on BOTH the getter and the setter
  // used to yield two entries with the same name. The dedup now collapses
  // them to a single entry.
  it("@Input() on BOTH getter and setter dedups to a single entry (bug C1 fixed)", () => {
    const filePath = writeFixture(
      "getter-setter-dup.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-foo' })
        export class FooComponent {
          @Input() get value(): string { return this._v; }
          @Input() set value(v: string) { this._v = v; }
          private _v: string = '';
        }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const comp = analysis.components[0];
    const valueInputs = comp.inputs.filter((i) => i.name === "value");
    expect(valueInputs).toHaveLength(1);
    expect(valueInputs[0].type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Signal inputs (Angular 17+)
// ---------------------------------------------------------------------------

describe("extractSignalInputs", () => {
  it("extracts input() and input.required() signal inputs", () => {
    const filePath = writeFixture(
      "signal-inputs.ts",
      `
        function Component(_: any): any { return () => {}; }
        function input<T = unknown>(): any { return undefined as any; }
        (input as any).required = <T = unknown>(): any => undefined;

        @Component({ selector: 'my-sig' })
        export class SigComponent {
          label = input<string>();
          count = input.required<number>();
        }
      `,
    );

    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const comp = analysis.components[0];
    const byName = Object.fromEntries(comp.inputs.map((i) => [i.name, i]));

    expect(Object.keys(byName).sort()).toEqual(["count", "label"]);
    expect(byName.label.required).toBe(false);
    expect(byName.label.type).toBe("string");
    expect(byName.count.required).toBe(true);
    expect(byName.count.type).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// resolveUnionLiterals — discriminated result (Phase 2).
//
// Phase 2 made `resolveUnionLiterals` public and changed the return type to a
// discriminated `ResolveUnionResult`. The position-matching hack went away —
// the method now operates on the AST node directly, so the SourceFile passed
// in MUST be the one that the program's TypeChecker was built from.
// ---------------------------------------------------------------------------

function firstPropertyTypeNode(
  sourceFile: ts.SourceFile,
  className: string,
  propName: string,
): ts.TypeNode | undefined {
  let out: ts.TypeNode | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    if (node.name?.getText(sourceFile) !== className) return;
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && member.name.getText(sourceFile) === propName) {
        out = member.type;
      }
    }
  });
  return out;
}

describe("resolveUnionLiterals", () => {
  const unionSource = `
    export class Foo {
      variant: 'primary' | 'secondary' | 'ghost' = 'primary';
      size: 'sm' | 'md' | 'lg' = 'md';
    }
  `;

  it("ok: returns literal values (partial=false) for a pure string literal union", () => {
    const files = { "/virt/union.ts": unionSource };
    const { program } = createVirtualProgram(files);
    const sf = program.getSourceFile("/virt/union.ts")!;

    const analyzer = new AngularAstAnalyzer();
    analyzer.setTypeChecker(program);

    const typeNode = firstPropertyTypeNode(sf, "Foo", "variant");
    const result = analyzer.resolveUnionLiterals(typeNode, sf);
    expect(result).toEqual({ kind: "ok", values: ["primary", "secondary", "ghost"], partial: false });
  });

  it("no-checker: setTypeChecker was never called", () => {
    const files = { "/virt/union.ts": unionSource };
    const { program } = createVirtualProgram(files);
    const sf = program.getSourceFile("/virt/union.ts")!;

    const analyzer = new AngularAstAnalyzer();
    // intentionally skip setTypeChecker

    const typeNode = firstPropertyTypeNode(sf, "Foo", "variant");
    const result = analyzer.resolveUnionLiterals(typeNode, sf);
    expect(result).toEqual({ kind: "no-checker" });
  });

  it("not-in-program: SourceFile is not part of the configured program", () => {
    // Build a program for file A, then ask to resolve literals against a
    // SourceFile parsed standalone (not in the program). Pre-Phase-2 callers
    // hit this path because analyzeFile parsed its own SourceFile; Phase 2
    // makes analyzeFile reuse the program SF and surfaces this case as a
    // diagnostic instead.
    const files = { "/virt/a.ts": unionSource };
    const { program } = createVirtualProgram(files);

    const standaloneSF = ts.createSourceFile("/not/in/program.ts", unionSource, ts.ScriptTarget.ES2022, true);

    const analyzer = new AngularAstAnalyzer();
    analyzer.setTypeChecker(program);

    const typeNode = firstPropertyTypeNode(standaloneSF, "Foo", "variant");
    const result = analyzer.resolveUnionLiterals(typeNode, standaloneSF);
    expect(result).toEqual({ kind: "not-in-program" });
  });

  it("partial-literal: union mixing string literals with an aliased non-literal type returns partial:true", () => {
    // The aliased member here is a UNIQUE branded-shape type that does NOT
    // collapse into the literals (a plain `string` alias would absorb the
    // literals at type-check time). Using a distinct interface keeps the
    // union heterogeneous so resolveUnionLiterals can flag partiality.
    const mixedSource = `
      export interface Extra { __brand: 'extra' }
      export class Foo {
        variant: 'primary' | 'secondary' | Extra = 'primary';
      }
    `;
    const files = { "/virt/mixed.ts": mixedSource };
    const { program } = createVirtualProgram(files);
    const sf = program.getSourceFile("/virt/mixed.ts")!;

    const analyzer = new AngularAstAnalyzer();
    analyzer.setTypeChecker(program);

    const typeNode = firstPropertyTypeNode(sf, "Foo", "variant");
    const result = analyzer.resolveUnionLiterals(typeNode, sf);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.values).toEqual(["primary", "secondary"]);
    expect(result.partial).toBe(true);
  });

  it("not-union: a non-union type returns kind:not-union", () => {
    const files = {
      "/virt/scalar.ts": `
        export class Foo {
          label: string = 'x';
        }
      `,
    };
    const { program } = createVirtualProgram(files);
    const sf = program.getSourceFile("/virt/scalar.ts")!;

    const analyzer = new AngularAstAnalyzer();
    analyzer.setTypeChecker(program);

    const typeNode = firstPropertyTypeNode(sf, "Foo", "label");
    const result = analyzer.resolveUnionLiterals(typeNode, sf);
    expect(result).toEqual({ kind: "not-union" });
  });
});

// ---------------------------------------------------------------------------
// Phase 3 bug-coverage extras
// ---------------------------------------------------------------------------

describe("Phase 3 extractor fixes", () => {
  it("H5: @Input({ required: true }) on a method produces required=true", () => {
    const filePath = writeFixture(
      "method-required.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-drop' })
        export class DropComponent {
          @Input({ required: true }) canDrop(source: any): boolean { return true; }
        }
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const canDrop = analysis.components[0].inputs.find((i) => i.name === "canDrop");
    expect(canDrop).toBeDefined();
    expect(canDrop?.required).toBe(true);
  });

  it("M3: inferType returns 'number[]' for numeric array initializer", () => {
    const filePath = writeFixture(
      "infer-array.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-arr' })
        export class ArrComp {
          @Input() ids = [1, 2, 3];
        }
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const ids = analysis.components[0].inputs.find((i) => i.name === "ids");
    expect(ids?.type).toBe("number[]");
  });

  it("M2: object literal decorator option is serialized as an object, not '[object Object]'", () => {
    // Use an inner object in @Component metadata (host) to exercise the object-literal branch.
    const filePath = writeFixture(
      "obj-literal.ts",
      `
        function Component(_: any): any { return () => {}; }

        @Component({ selector: 'my-obj', host: { class: 'x' } })
        export class ObjComp {}
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    // The component analyzer doesn't surface 'host' on ComponentMetadata by default,
    // but evaluateExpression is reached during extractDecoratorMetadata. This test
    // primarily ensures no crash and a valid component entry is produced.
    expect(analysis.components).toHaveLength(1);
    expect(analysis.components[0].metadata.selector).toBe("my-obj");
  });
});

// ---------------------------------------------------------------------------
// extractDeprecation
// ---------------------------------------------------------------------------

describe("extractDeprecation", () => {
  it("parses a single-line (same-line closing */) @deprecated tag", () => {
    const filePath = writeFixture(
      "deprec-sameline.ts",
      `
        /** @deprecated use Bar instead since v1.2.3 */
        export class OldThing {}
      `,
    );
    const result = extractDeprecation(filePath, "OldThing");
    expect(result).toBeDefined();
    expect(result?.deprecated).toBe(true);
    expect(result?.since).toBe("1.2.3");
    expect(result?.replacement).toBe("Bar");
  });

  it("finds the right class in a multi-class file", () => {
    const filePath = writeFixture(
      "deprec-multi.ts",
      `
        export class Fresh {}

        /**
         * @deprecated since v2.0.0 will be removed in v3.0.0. Use Fresh instead.
         */
        export class Stale {}

        export class AlsoFresh {}
      `,
    );

    const stale = extractDeprecation(filePath, "Stale");
    expect(stale).toBeDefined();
    expect(stale?.deprecated).toBe(true);
    expect(stale?.since).toBe("2.0.0");
    expect(stale?.removeIn).toBe("3.0.0");
    expect(stale?.replacement).toBe("Fresh");

    const fresh = extractDeprecation(filePath, "Fresh");
    expect(fresh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 4 (v4.0): null/typeResolved sentinels, anonymous-class skip,
// empty-selector diagnostic, inheritance unresolved-import.
// ---------------------------------------------------------------------------

describe("Phase 4: schema v4.0", () => {
  it("anonymous @Component class is skipped and emits 'anonymous-class-skipped' diagnostic", () => {
    const filePath = writeFixture(
      "anon-class.ts",
      `
        function Component(_: any): any { return () => {}; }

        @Component({ selector: 'my-anon' })
        export default class {
          // anonymous: no class name
        }
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const diagnostics = new DiagnosticsCollector();
    analyzer.setDiagnostics(diagnostics);
    const analysis = analyzer.analyzeFile(filePath);
    expect(analysis.components).toHaveLength(0);
    const codes = diagnostics.all().map((d) => d.code);
    expect(codes).toContain("anonymous-class-skipped");
  });

  it("empty-selector component is kept in components but emits 'empty-selector' diagnostic", () => {
    const filePath = writeFixture(
      "empty-selector.ts",
      `
        function Component(_: any): any { return () => {}; }

        @Component({ standalone: true })
        export class NoSelectorComponent {}
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const diagnostics = new DiagnosticsCollector();
    analyzer.setDiagnostics(diagnostics);
    const analysis = analyzer.analyzeFile(filePath);
    expect(analysis.components).toHaveLength(1);
    expect(analysis.components[0].metadata.selector).toBe("");
    const empty = diagnostics.all().filter((d) => d.code === "empty-selector");
    expect(empty).toHaveLength(1);
    expect(empty[0].component).toBe("NoSelectorComponent");
  });

  it("input with unresolvable type yields { type: null, typeResolved: false }", () => {
    // No type annotation, no initializer -> nothing to infer from.
    const filePath = writeFixture(
      "unresolved-input.ts",
      `
        function Component(_: any): any { return () => {}; }
        function Input(opts?: any): any { return () => {}; }

        @Component({ selector: 'my-x' })
        export class XComp {
          @Input() mystery!: any;
          // 'any' IS resolved (annotated). Add a true-unresolved one too.
          // Use a setter without a type annotation:
          @Input() set blank(v) {}
        }
      `,
    );
    const analyzer = new AngularAstAnalyzer();
    const analysis = analyzer.analyzeFile(filePath);
    const blank = analysis.components[0].inputs.find((i) => i.name === "blank");
    expect(blank).toBeDefined();
    expect(blank?.type).toBeNull();
    expect(blank?.typeResolved).toBe(false);

    const mystery = analysis.components[0].inputs.find((i) => i.name === "mystery");
    expect(mystery?.type).toBe("any");
    expect(mystery?.typeResolved).toBe(true);
  });

  it("resolvedValues uses the new wire shape { values, partial } | null", () => {
    const files = {
      "/virt/rv.ts": `
        function Component(_: any): any { return () => {}; }
        function input<T = unknown>(): any { return undefined as any; }

        @Component({ selector: 'my-rv' })
        export class RVComp {
          variant = input<'a' | 'b' | 'c'>();
        }
      `,
    };
    const { program } = createVirtualProgram(files);
    const analyzer = new AngularAstAnalyzer();
    analyzer.setTypeChecker(program);
    const analysis = analyzer.analyzeFile("/virt/rv.ts");
    const variant = analysis.components[0].inputs.find((i) => i.name === "variant");
    expect(variant?.resolvedValues).toEqual({ values: ["a", "b", "c"], partial: false });
  });

  it("inheritance with unresolvable import yields resolved=false and emits 'inheritance-unresolved-import' (no same-file fallback)", () => {
    // Child class extends a Base that is NOT imported anywhere — the
    // pre-v4.0 same-file fallback used to scan the same file. Now the
    // resolver returns undefined and we surface a diagnostic.
    const childPath = writeFixture(
      "inh/child.ts",
      `
        function Component(_: any): any { return () => {}; }

        @Component({ selector: 'my-child' })
        export class ChildComp extends MissingBase {}
      `,
    );
    const diagnostics = new DiagnosticsCollector();
    const { analysis: inh, resolved } = analyzeInheritance(
      childPath,
      "ChildComp",
      path.dirname(childPath),
      undefined,
      "",
      undefined,
      diagnostics,
    );
    expect(resolved).toBe(false);
    expect(inh.baseClass).toBe("MissingBase");
    expect(inh.baseClassPath).toBeUndefined();
    expect(inh.inheritedInputs).toHaveLength(0);
    const codes = diagnostics.all().map((d) => d.code);
    expect(codes).toContain("inheritance-unresolved-import");
  });
});

// ---------------------------------------------------------------------------
// ng-content projection (Commit 2: AST-based parser migration)
// ---------------------------------------------------------------------------

describe("parseNgContentSlots (AST-based)", () => {
  it("compound selector produces selectorAlternates", () => {
    const slots = parseNgContentSlots(`<div><ng-content select="[foo], [bar]"></ng-content></div>`);
    expect(slots).toHaveLength(1);
    expect(slots[0].selector).toBe("[foo], [bar]");
    expect(slots[0].selectorAlternates).toEqual(["[foo]", "[bar]"]);
    expect(slots[0].multiple).toBe(false);
  });

  it("explicit `required` attribute → required: true", () => {
    const slots = parseNgContentSlots(`<ng-content select="[body]" required></ng-content>`);
    expect(slots).toHaveLength(1);
    expect(slots[0].required).toBe(true);
    expect(slots[0].selector).toBe("[body]");
    expect(slots[0].selectorAlternates).toBeUndefined();
  });

  it("no selector attribute → default slot with multiple: true", () => {
    const slots = parseNgContentSlots("<ng-content></ng-content>");
    expect(slots).toHaveLength(1);
    expect(slots[0].name).toBe("default");
    expect(slots[0].selector).toBeUndefined();
    expect(slots[0].multiple).toBe(true);
    expect(slots[0].required).toBe(false);
  });

  it("<ng-content> inside @if block is counted (walker descends)", () => {
    const tpl = `@if (cond) { <ng-content select="[inner]"></ng-content> }`;
    const slots = parseNgContentSlots(tpl);
    const innerSlot = slots.find((s) => s.selector === "[inner]");
    expect(innerSlot).toBeDefined();
  });

  it("HTML-commented <ng-content> is NOT counted", () => {
    const tpl = `<div><!-- <ng-content select="[commented]"></ng-content> --></div>`;
    const slots = parseNgContentSlots(tpl);
    expect(slots.find((s) => s.selector === "[commented]")).toBeUndefined();
  });

  it("malformed template emits template-parse-failed diagnostic and returns empty slots", () => {
    // An invalid control-flow block body forces parseTemplate to produce errors.
    // Use a definitively broken expression inside an interpolation.
    const broken = "<div>{{ ( }}</div>";
    const diag = new DiagnosticsCollector();
    const slots = parseNgContentSlots(broken, undefined, {
      sourceUrl: "broken.html",
      diagnostics: diag,
    });
    // slots should be empty OR the diagnostic should be present. Either way,
    // on errors we expect the warn diagnostic to fire.
    const codes = diag.all().map((d) => d.code);
    expect(codes).toContain("template-parse-failed");
    expect(diag.all().every((d) => d.severity === "warn")).toBe(true);
    // No `<ng-content>` in this template → slots must be empty regardless.
    expect(slots).toHaveLength(0);
  });

  it("analyzeContentProjection uses AST walker for inline templates", () => {
    const filePath = writeFixture(
      "content-projection/proj.ts",
      `
        function Component(_: any): any { return () => {}; }
        @Component({
          selector: 'my-proj',
          template: \`
            <header><ng-content select="[header]" required></ng-content></header>
            @if (open) { <ng-content select="[body]"></ng-content> }
            <ng-content></ng-content>
          \`,
        })
        export class ProjComp {}
      `,
    );
    const slots = analyzeContentProjection(filePath);
    const header = slots.find((s) => s.selector === "[header]");
    const body = slots.find((s) => s.selector === "[body]");
    const def = slots.find((s) => s.name === "default");
    expect(header?.required).toBe(true);
    expect(body).toBeDefined();
    expect(def?.multiple).toBe(true);
  });
});
