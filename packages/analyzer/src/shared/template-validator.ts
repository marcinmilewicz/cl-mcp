/**
 * Angular Template Validator
 * Validates template strings against component API definitions.
 *
 * As of schema v4.1 the binding extractor walks the R3 AST produced by
 * `@angular/compiler`'s `parseTemplate` (via the shared `template-parser.ts`
 * wrapper) instead of using regex. This unlocks:
 *   - Angular 17+ control-flow descent (`@if` / `@for` / `@switch` / `@defer`).
 *   - Legacy structural directives (`*ngIf` / `*ngFor`, surfaced as
 *     `TmplAstTemplate` with `templateAttrs`).
 *   - Attribute-directive recognition (e.g. `<button mat-button matTooltip>`).
 *   - Honest source spans on every error/warning.
 *   - Pipe argument-count validation against a built-in arity table.
 */

import type {
  AST,
  ASTWithSource,
  BindingPipe,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstBoundText,
  TmplAstElement,
  TmplAstTemplate,
  TmplAstTextAttribute,
} from "@angular/compiler";

import type {
  ComponentAnalysis,
  FileAnalysis,
  StrictComponentAPI,
  StrictInput,
  StrictOutput,
  TemplateSourceSpan,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from "../types.js";
import { asSelector } from "../types.js";
import type { DiagnosticsCollector } from "./diagnostics.js";
import {
  TemplateParseCache,
  isAngularCompilerAvailable,
  requireAngularCompiler,
  walkTemplate,
} from "./template-parser.js";

// ============================================================================
// Types
// ============================================================================

type SpannedName = { name: string; sourceSpan?: TemplateSourceSpan };
type SpannedAttr = { name: string; value: string; sourceSpan?: TemplateSourceSpan };

/**
 * Intermediate shape produced by `extractBindings()`. One entry per rendered
 * element (both plain `TmplAstElement` and `TmplAstTemplate`-wrapped
 * structural-directive hosts).
 */
interface ElementBinding {
  tagName: string;
  inputs: SpannedName[];
  outputs: SpannedName[];
  attributes: SpannedAttr[];
  /**
   * Attributes that could be attribute-directive selectors: bare attributes
   * (no `data-` / `aria-` / known-HTML / known-Angular-directive namespace).
   * Resolved against `directiveAPIs` at validate-time.
   */
  directiveAttrs: SpannedName[];
  /**
   * Value expressions attached to this element (BoundAttribute.value on
   * regular inputs, plus BoundText on children). Collected here so pipe
   * walks aren't re-done separately and source spans stay tied to the
   * element the binding lives on.
   */
  valueExpressions: Array<{ ast: AST; sourceSpan?: TemplateSourceSpan }>;
  sourceSpan?: TemplateSourceSpan;
}

// ============================================================================
// Module-level lookup sets
// ============================================================================

const commonHtmlAttributes: ReadonlySet<string> = new Set([
  "class",
  "id",
  "style",
  "type",
  "name",
  "value",
  "href",
  "src",
  "alt",
  "title",
  "target",
  "rel",
  "role",
  "tabindex",
  "slot",
  "for",
  "placeholder",
  "disabled",
  "checked",
  "readonly",
  "required",
  "multiple",
  "selected",
  "autocomplete",
  "autofocus",
  "min",
  "max",
  "step",
  "pattern",
  "maxlength",
  "minlength",
  "rows",
  "cols",
  "colspan",
  "rowspan",
]);

const angularDirectives: ReadonlySet<string> = new Set([
  "ngIf",
  "ngFor",
  "ngForOf",
  "ngSwitch",
  "ngSwitchCase",
  "ngSwitchDefault",
  "ngClass",
  "ngStyle",
  "ngModel",
  "ngModelChange",
  "ngForm",
  "formControlName",
  "formGroupName",
  "formArrayName",
  "formControl",
  "formGroup",
  "routerLink",
  "routerLinkActive",
  "ngTemplateOutlet",
  "ngComponentOutlet",
  "ngContent",
  "ngProjectAs",
  "cdkPortal",
]);

const builtInPipes: ReadonlySet<string> = new Set([
  "async",
  "date",
  "uppercase",
  "lowercase",
  "titlecase",
  "currency",
  "decimal",
  "number",
  "percent",
  "slice",
  "json",
  "keyvalue",
  "i18nPlural",
  "i18nSelect",
]);

/**
 * Arity table for built-in Angular pipes. `[min, max]` inclusive on the number
 * of arguments after the piped value (i.e. `args.length` on `BindingPipe`).
 * Unknown / user pipes skip the check.
 */
const builtInPipeArity: Readonly<Record<string, readonly [number, number]>> = {
  async: [0, 0],
  date: [0, 1],
  uppercase: [0, 0],
  lowercase: [0, 0],
  titlecase: [0, 0],
  currency: [0, 3],
  decimal: [0, 1],
  number: [0, 3],
  percent: [0, 3],
  slice: [1, 2],
  json: [0, 0],
  keyvalue: [0, 1],
  i18nPlural: [1, 2],
  i18nSelect: [1, 1],
};

// ============================================================================
// Template Validator Class
// ============================================================================

/**
 * One comma-clause of a CSS selector, reduced to what template validation
 * needs: a tag requirement and required attribute names. `hadNegation` marks
 * clauses that contained `:not(...)` — those match conservatively (the
 * negation is ignored), so required-input enforcement is skipped for them.
 */
interface SelectorClauseMatcher {
  tag: string | null;
  attrs: readonly string[];
  hadNegation: boolean;
  api: StrictComponentAPI;
}

/** Split a selector list on top-level commas (not inside `[]` / `()`). */
function splitSelectorList(selector: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of selector) {
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      clauses.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  clauses.push(current);
  return clauses.map((c) => c.trim()).filter(Boolean);
}

/** Parse one clause into `{tag, attrs, hadNegation}`; null when unusable. */
function parseSelectorClause(clause: string): Omit<SelectorClauseMatcher, "api"> | null {
  let s = clause.trim();
  const hadNegation = s.includes(":not(");
  s = s.replace(/:not\([^)]*\)/g, "");
  const attrs = Array.from(s.matchAll(/\[([^\]=]+)(?:=[^\]]*)?\]/g)).map((m) => m[1].trim());
  const tagText = s.replace(/\[[^\]]*\]/g, "").trim();
  const tag = /^[A-Za-z][\w-]*$/.test(tagText) ? tagText : null;
  if (!tag && attrs.length === 0) return null;
  return { tag, attrs, hadNegation };
}

export class TemplateValidator {
  private componentAPIs: Map<string, StrictComponentAPI> = new Map();
  private directiveAPIs: Map<string, StrictComponentAPI> = new Map();
  /** Clause matchers for compound selectors (`button[mat-button]`, comma lists). */
  private compoundMatchers: SelectorClauseMatcher[] = [];
  private registeredPipes: Set<string> = new Set();
  private readonly selectorPrefix: string;
  private readonly libraryName: string;
  private readonly diagnostics?: DiagnosticsCollector;
  private readonly parseCache: TemplateParseCache;

  /**
   * Maximum allowed template length to prevent resource exhaustion.
   */
  private static readonly MAX_TEMPLATE_LENGTH = 100_000;

  constructor(
    options: {
      selectorPrefix?: string;
      libraryName?: string;
      diagnostics?: DiagnosticsCollector;
      parseCache?: TemplateParseCache;
    } = {},
  ) {
    this.selectorPrefix = options.selectorPrefix ?? "";
    this.libraryName = options.libraryName ?? "component library";
    this.diagnostics = options.diagnostics;
    this.parseCache = options.parseCache ?? new TemplateParseCache();
  }

  registerFromAnalysis(analyses: readonly FileAnalysis[]): void {
    for (const analysis of analyses) {
      for (const component of analysis.components) {
        const api = buildStrictAPIFromAnalysis(component);
        this.registerSelector(api);
        if (this.selectorPrefix && api.selector.startsWith(this.selectorPrefix)) {
          this.componentAPIs.set(api.selector.slice(this.selectorPrefix.length), api);
        }
      }

      for (const directive of analysis.directives) {
        const api = buildStrictAPIFromAnalysis(directive);
        if (!api.selector) continue;
        this.registerSelector(api);
      }

      for (const pipe of analysis.pipes || []) {
        if (pipe.pipeName) {
          this.registeredPipes.add(pipe.pipeName);
        }
      }
    }
  }

  /**
   * Register an API under every form its selector can match in a template:
   * the raw string (back-compat / `getRegisteredSelectors`), plain element
   * tags per comma clause, attribute-directive names, and clause matchers
   * for compound selectors like `button[mat-button], a[mat-button]`.
   */
  private registerSelector(api: StrictComponentAPI): void {
    this.componentAPIs.set(api.selector, api);

    for (const clauseText of splitSelectorList(api.selector)) {
      const clause = parseSelectorClause(clauseText);
      if (!clause) continue;

      if (clause.attrs.length === 0 && clause.tag) {
        // Plain element clause (`mat-card`) — direct tag lookup.
        this.componentAPIs.set(clause.tag, api);
        continue;
      }

      // Attribute-bearing clause — matched structurally at validate time.
      this.compoundMatchers.push({ ...clause, api });
      if (!clause.tag && clause.attrs.length === 1) {
        // Pure attribute selector (`[matTooltip]`) — also an attribute
        // directive that can sit on any host element.
        this.directiveAPIs.set(clause.attrs[0], api);
      }
    }
  }

  /**
   * Resolve every API matching an element: exact tag lookup first, then
   * compound clause matchers (tag equal or absent AND every selector
   * attribute present on the element). Returns the deduped APIs, the subset
   * that may enforce required inputs (negated clauses match conservatively,
   * so they don't), and the selector attributes that did the matching (those
   * are not typos).
   */
  private resolveElementApis(binding: ElementBinding): {
    apis: StrictComponentAPI[];
    requiredFrom: StrictComponentAPI[];
    matchedAttrs: Set<string>;
  } {
    const apis: StrictComponentAPI[] = [];
    const requiredFrom = new Set<StrictComponentAPI>();
    const matchedAttrs = new Set<string>();

    const exact = this.componentAPIs.get(binding.tagName);
    if (exact) {
      apis.push(exact);
      requiredFrom.add(exact);
    }

    const present = new Set<string>([
      ...binding.attributes.map((a) => a.name),
      ...binding.directiveAttrs.map((a) => a.name),
    ]);

    for (const matcher of this.compoundMatchers) {
      if (matcher.tag && matcher.tag !== binding.tagName) continue;
      if (!matcher.attrs.every((attr) => present.has(attr))) continue;
      if (!apis.includes(matcher.api)) apis.push(matcher.api);
      if (!matcher.hadNegation) requiredFrom.add(matcher.api);
      for (const attr of matcher.attrs) matchedAttrs.add(attr);
    }

    return { apis, requiredFrom: [...requiredFrom].filter((api) => apis.includes(api)), matchedAttrs };
  }

  /**
   * Register inherited inputs/outputs for all registered components.
   */
  registerInheritedProperties(
    inheritedInputs: ReadonlyArray<{
      name: string;
      type: string | null;
      typeResolved?: boolean;
      required: boolean;
      defaultValue?: string;
      description?: string;
    }>,
    inheritedOutputs: ReadonlyArray<{
      name: string;
      eventType: string | null;
      eventTypeResolved?: boolean;
      description?: string;
    }>,
  ): void {
    for (const [_selector, api] of this.componentAPIs) {
      const mutInputs = api.availableInputs as StrictInput[];
      for (const input of inheritedInputs) {
        if (!mutInputs.some((i) => i.name === input.name)) {
          mutInputs.push({
            name: input.name,
            type: input.type,
            typeResolved: input.typeResolved ?? input.type !== null,
            required: input.required,
            defaultValue: input.required ? undefined : input.defaultValue,
            description: input.description || `Inherited input ${input.name}`,
            example: generateInputExample(input.name, input.type),
          });
        }
      }

      const mutOutputs = api.availableOutputs as StrictOutput[];
      for (const output of inheritedOutputs) {
        if (!mutOutputs.some((o) => o.name === output.name)) {
          mutOutputs.push({
            name: output.name,
            eventType: output.eventType,
            eventTypeResolved: output.eventTypeResolved ?? output.eventType !== null,
            description: output.description || `Inherited output ${output.name}`,
            example: `(${output.name})="on${capitalize(output.name)}($event)"`,
          });
        }
      }
    }
  }

  getComponentAPI(selector: string): StrictComponentAPI | undefined {
    return this.componentAPIs.get(selector);
  }

  getRegisteredSelectors(): string[] {
    return Array.from(this.componentAPIs.keys());
  }

  /**
   * Validate a template string.
   */
  validate(template: string): ValidationResult {
    if (!isAngularCompilerAvailable()) {
      return {
        errors: [
          {
            type: "angular-compiler-unavailable",
            message:
              "Angular template validation requires @angular/compiler, which is not installed. " +
              "Install it (e.g. `npm i -D @angular/compiler`) to validate Angular templates.",
            element: "",
          },
        ],
        warnings: [],
        suggestions: [],
      };
    }

    if (template.length > TemplateValidator.MAX_TEMPLATE_LENGTH) {
      return {
        errors: [
          {
            type: "template-too-large",
            message: `Template exceeds maximum allowed length of ${TemplateValidator.MAX_TEMPLATE_LENGTH} characters (got ${template.length}).`,
            element: "",
          },
        ],
        warnings: [],
        suggestions: [],
      };
    }

    let parsed: ReturnType<TemplateParseCache["get"]>;
    try {
      parsed = this.parseCache.get(template, "template-validator.html");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.diagnostics?.push({
        severity: "error",
        code: "template-parse-failed",
        message: `Template parse threw: ${msg}`,
      });
      return {
        errors: [],
        warnings: [
          {
            type: "template-parse-failed",
            message: `Template could not be parsed: ${msg}`,
          },
        ],
        suggestions: [],
      };
    }
    const parseErrors = parsed.errors ?? [];
    const hasParseErrors = parseErrors.length > 0;

    // Malformed template with NO recovered nodes: emit ERROR diagnostic (actual
    // metadata is lost), return a single parse-failed warning so callers still
    // see a result.
    if (hasParseErrors && (!parsed.nodes || parsed.nodes.length === 0)) {
      const msg = parseErrors
        .slice(0, 3)
        .map((e) => e.msg ?? String(e))
        .join("; ");
      this.diagnostics?.push({
        severity: "error",
        code: "template-parse-failed",
        message: `Template parse failed: ${msg}`,
      });
      return {
        errors: [],
        warnings: [
          {
            type: "template-parse-failed",
            message: `Template could not be parsed: ${msg}`,
          },
        ],
        suggestions: [],
      };
    }

    // Parse errors present but nodes recovered: emit warn diagnostic, still validate.
    if (hasParseErrors) {
      const msg = parseErrors
        .slice(0, 3)
        .map((e) => e.msg ?? String(e))
        .join("; ");
      this.diagnostics?.push({
        severity: "warn",
        code: "template-parse-failed",
        message: `Template parse failed (partial recovery): ${msg}`,
      });
    }

    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const suggestions: string[] = [];

    const bindings = this.extractBindings(parsed.nodes);

    for (const binding of bindings) {
      // Every API active on this element: exact tag match + compound-selector
      // clauses (`button[mat-button]`). A binding is valid if ANY of them
      // declares it — components and attribute directives share the host.
      const { apis, requiredFrom, matchedAttrs } = this.resolveElementApis(binding);

      if (apis.length === 0) {
        if (this.selectorPrefix && binding.tagName.startsWith(this.selectorPrefix)) {
          errors.push({
            type: "unknown-element",
            message: `Unknown ${this.libraryName} component: <${binding.tagName}>`,
            element: binding.tagName,
            suggestion: "Check component name spelling or ensure it is imported",
            ...(binding.sourceSpan ? { sourceSpan: binding.sourceSpan } : {}),
          });
        }
        // Still validate pipes inside value expressions of unknown elements.
        this.validateExpressionPipes(binding.valueExpressions, warnings);
        continue;
      }

      const availableInputNames = [...new Set(apis.flatMap((a) => a.availableInputs.map((i) => i.name)))];
      const availableOutputNames = [...new Set(apis.flatMap((a) => a.availableOutputs.map((o) => o.name)))];

      // Inputs
      for (const input of binding.inputs) {
        if (availableInputNames.includes(input.name)) continue;

        // Might be a directive selector itself, or an input on a directive
        // active on this host.
        const isDirectiveSelector = this.directiveAPIs.has(input.name);
        const isDirectiveInput = binding.directiveAttrs.some((dirAttr) => {
          const dirApi = this.directiveAPIs.get(dirAttr.name);
          return dirApi?.availableInputs.some((i) => i.name === input.name);
        });
        const isAngularDirective = angularDirectives.has(input.name);

        if (!isDirectiveSelector && !isDirectiveInput && !isAngularDirective) {
          const similar = this.findSimilar(input.name, availableInputNames);
          errors.push({
            type: "unknown-input",
            message: `Input [${input.name}] does not exist on <${binding.tagName}>`,
            property: input.name,
            element: binding.tagName,
            suggestion: similar
              ? `Did you mean [${similar}]?`
              : `Available inputs: ${availableInputNames.join(", ") || "none"}`,
            ...(input.sourceSpan ? { sourceSpan: input.sourceSpan } : {}),
          });
        }
      }

      // Outputs
      for (const output of binding.outputs) {
        if (availableOutputNames.includes(output.name)) continue;

        const isDirectiveOutput = binding.directiveAttrs.some((dirAttr) => {
          const dirApi = this.directiveAPIs.get(dirAttr.name);
          return dirApi?.availableOutputs.some((o) => o.name === output.name);
        });
        const isAngularDirective = angularDirectives.has(output.name);
        // Two-way bindings synthesize `<prop>Change` outputs; if the matching
        // input exists on the API, the output pair is implicit-valid.
        const pairedInput = output.name.endsWith("Change")
          ? availableInputNames.includes(output.name.slice(0, -"Change".length))
          : false;

        if (!isDirectiveOutput && !isAngularDirective && !pairedInput) {
          errors.push({
            type: "unknown-output",
            message: `Output (${output.name}) does not exist on <${binding.tagName}>`,
            property: output.name,
            element: binding.tagName,
            suggestion: `Available outputs: ${availableOutputNames.join(", ") || "none"}`,
            ...(output.sourceSpan ? { sourceSpan: output.sourceSpan } : {}),
          });
        }
      }

      // Plain attributes: might be string inputs, or typos.
      for (const attr of binding.attributes) {
        if (this.isCommonHtmlAttribute(attr.name)) continue;
        if (this.isAngularDirective(attr.name)) continue;
        if (this.directiveAPIs.has(attr.name)) continue; // attribute directive selector
        if (matchedAttrs.has(attr.name)) continue; // part of a matched compound selector

        const matchingInput = apis.flatMap((a) => a.availableInputs).find((i) => i.name === attr.name);
        if (matchingInput) {
          if (matchingInput.type !== "string" && !attr.value.includes("{{")) {
            suggestions.push(`Consider using [${attr.name}] binding for non-string input on <${binding.tagName}>`);
          }
          continue;
        }

        const similar = this.findSimilar(attr.name, availableInputNames);
        if (similar) {
          errors.push({
            type: "unknown-input",
            message: `Attribute "${attr.name}" might be a typo on <${binding.tagName}>`,
            property: attr.name,
            element: binding.tagName,
            suggestion: `Did you mean [${similar}] or ${similar}?`,
            ...(attr.sourceSpan ? { sourceSpan: attr.sourceSpan } : {}),
          });
        }
      }

      // Required inputs — enforced per API whose selector clause matched
      // without a `:not(...)` (negated clauses match conservatively).
      for (const api of requiredFrom) {
        for (const requiredInput of api.availableInputs.filter((i) => i.required)) {
          const providedAsBinding = binding.inputs.some((i) => i.name === requiredInput.name);
          const providedAsAttribute = binding.attributes.some((a) => a.name === requiredInput.name);
          if (!providedAsBinding && !providedAsAttribute) {
            errors.push({
              type: "missing-required",
              message: `Required input [${requiredInput.name}] is missing on <${binding.tagName}>`,
              property: requiredInput.name,
              element: binding.tagName,
              ...(binding.sourceSpan ? { sourceSpan: binding.sourceSpan } : {}),
            });
          }
        }
      }

      // Pipes inside this element's value expressions.
      this.validateExpressionPipes(binding.valueExpressions, warnings);
    }

    return { errors, warnings, suggestions };
  }

  /**
   * AST-based binding extraction. One `ElementBinding` per host element
   * (`TmplAstElement`) or structural-directive wrapper (`TmplAstTemplate`).
   */
  private extractBindings(nodes: readonly unknown[] | undefined): ElementBinding[] {
    const out: ElementBinding[] = [];

    const pushElement = (el: TmplAstElement | TmplAstTemplate, tagName: string) => {
      const inputs: SpannedName[] = [];
      const outputs: SpannedName[] = [];
      const attributes: SpannedAttr[] = [];
      const directiveAttrs: SpannedName[] = [];
      const valueExpressions: ElementBinding["valueExpressions"] = [];

      // BoundAttribute: `[x]="…"` or two-way `[(x)]="…"` (two-way appears as
      // both a BoundAttribute AND a BoundEvent named `xChange`). Dedupe by
      // collecting BoundAttribute names into a Set; skip the paired
      // `${name}Change` event below.
      const inputNames = new Set<string>();
      const visitBoundAttrs = (boundAttrs: TmplAstBoundAttribute[]) => {
        for (const ba of boundAttrs) {
          inputs.push({ name: ba.name, sourceSpan: spanOf(ba) });
          inputNames.add(ba.name);
          if (ba.value) valueExpressions.push({ ast: ba.value as AST, sourceSpan: spanOf(ba) });
        }
      };
      const visitBoundEvents = (boundEvents: TmplAstBoundEvent[]) => {
        for (const be of boundEvents) {
          // Drop the auto-generated `Change` output of a two-way binding.
          if (be.name.endsWith("Change") && inputNames.has(be.name.slice(0, -"Change".length))) continue;
          outputs.push({ name: be.name, sourceSpan: spanOf(be) });
        }
      };
      const visitTextAttrs = (textAttrs: TmplAstTextAttribute[]) => {
        for (const ta of textAttrs) {
          // Skip references/variables emitted as attributes; `#ref` lives on
          // the element's `references` field, not `attributes`.
          const span = spanOf(ta);
          // Known-HTML / Angular-directive namespaces go to `attributes`;
          // everything else becomes a directive-selector candidate.
          const isHtml =
            commonHtmlAttributes.has(ta.name) || ta.name.startsWith("data-") || ta.name.startsWith("aria-");
          const isAng = angularDirectives.has(ta.name) || ta.name.startsWith("*");
          if (!isHtml && !isAng && !ta.value) {
            // Bare attribute with empty value → directive selector candidate
            // (`<button mat-button matTooltip>`). Also populate `attributes`
            // so required-input reconciliation still sees it.
            directiveAttrs.push({ name: ta.name, sourceSpan: span });
            attributes.push({ name: ta.name, value: ta.value, sourceSpan: span });
          } else if (!isHtml && !isAng && ta.value) {
            // e.g. `matTooltip="hi"` — both a directive selector AND an
            // attribute carrying its value.
            directiveAttrs.push({ name: ta.name, sourceSpan: span });
            attributes.push({ name: ta.name, value: ta.value, sourceSpan: span });
          } else {
            attributes.push({ name: ta.name, value: ta.value, sourceSpan: span });
          }
        }
      };

      if (isTemplateNode(el)) {
        const tpl = el;
        visitBoundAttrs(tpl.inputs as TmplAstBoundAttribute[]);
        visitBoundEvents(tpl.outputs as TmplAstBoundEvent[]);
        visitTextAttrs(tpl.attributes as TmplAstTextAttribute[]);
        // Structural directive attrs: `*ngFor`, `let-…`, etc. Collected onto
        // templateAttrs as TextAttribute / BoundAttribute pairs.
        for (const ta of tpl.templateAttrs as Array<TmplAstBoundAttribute | TmplAstTextAttribute>) {
          if ("value" in ta && typeof ta.value === "string") {
            attributes.push({ name: ta.name, value: ta.value, sourceSpan: spanOf(ta) });
          } else {
            inputs.push({ name: ta.name, sourceSpan: spanOf(ta) });
            inputNames.add(ta.name);
            const val = (ta as TmplAstBoundAttribute).value;
            if (val) valueExpressions.push({ ast: val as AST, sourceSpan: spanOf(ta) });
          }
        }
      } else {
        const e = el;
        visitBoundAttrs(e.inputs);
        visitBoundEvents(e.outputs);
        visitTextAttrs(e.attributes);
      }

      out.push({
        tagName,
        inputs,
        outputs,
        attributes,
        directiveAttrs,
        valueExpressions,
        sourceSpan: spanOf(el as { sourceSpan?: unknown }),
      });
    };

    // Walker populates elements; BoundText value expressions are attached to
    // a synthetic "#text" binding so pipes in `{{ x | date }}` are validated.
    const textExpressions: ElementBinding["valueExpressions"] = [];

    walkTemplate(nodes as Parameters<typeof walkTemplate>[0], {
      visitElement(el) {
        pushElement(el, el.name);
      },
      visitTemplate(tpl) {
        // Structural-directive-hosted element. `tpl.tagName` is the rendered
        // element (for `<div *ngIf>` it's "div"; for `<ng-template>` it's
        // null).
        const tagName = (tpl as TmplAstTemplate).tagName ?? "ng-template";
        pushElement(tpl as TmplAstTemplate, tagName);
      },
      visitBoundText(bt: TmplAstBoundText) {
        const val = bt.value as AST;
        if (val) textExpressions.push({ ast: val, sourceSpan: spanOf(bt) });
      },
    });

    if (textExpressions.length > 0) {
      out.push({
        tagName: "#text",
        inputs: [],
        outputs: [],
        attributes: [],
        directiveAttrs: [],
        valueExpressions: textExpressions,
      });
    }

    return out;
  }

  private validateExpressionPipes(
    exprs: ReadonlyArray<{ ast: AST; sourceSpan?: TemplateSourceSpan }>,
    warnings: ValidationWarning[],
  ): void {
    if (exprs.length === 0) return;

    for (const { ast, sourceSpan } of exprs) {
      const pipes = collectPipes(ast);
      for (const pipe of pipes) {
        const isBuiltIn = builtInPipes.has(pipe.name);
        const isRegistered = this.registeredPipes.has(pipe.name);

        if (!isBuiltIn && !isRegistered && this.registeredPipes.size > 0) {
          warnings.push({
            type: "unknown-pipe",
            message: `Pipe "${pipe.name}" is not a known library pipe`,
            property: pipe.name,
            element: "pipe",
            ...(sourceSpan ? { sourceSpan } : {}),
          });
          continue;
        }

        if (isBuiltIn) {
          const arity = builtInPipeArity[pipe.name];
          if (arity) {
            const [min, max] = arity;
            const n = pipe.args.length;
            if (n < min || n > max) {
              warnings.push({
                type: "pipe-arg-count-mismatch",
                message: `Pipe "${pipe.name}" received ${n} argument${n === 1 ? "" : "s"}; expected ${min === max ? min : `${min}..${max}`}`,
                property: pipe.name,
                element: "pipe",
                ...(sourceSpan ? { sourceSpan } : {}),
              });
            }
          }
        }
      }
    }
  }

  private isCommonHtmlAttribute(name: string): boolean {
    if (name.startsWith("data-") || name.startsWith("aria-")) return true;
    return commonHtmlAttributes.has(name);
  }

  private isAngularDirective(name: string): boolean {
    return angularDirectives.has(name) || name.startsWith("*") || name.startsWith("let-") || name.startsWith("#");
  }

  private findSimilar(target: string, candidates: string[]): string | null {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = this.levenshtein(target.toLowerCase(), candidate.toLowerCase());
      if (distance < bestDistance && distance <= 3) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] =
          b.charAt(i - 1) === a.charAt(j - 1)
            ? matrix[i - 1][j - 1]
            : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isTemplateNode(n: TmplAstElement | TmplAstTemplate): n is TmplAstTemplate {
  return Array.isArray((n as TmplAstTemplate).templateAttrs);
}

function spanOf(node: unknown): TemplateSourceSpan | undefined {
  const n = node as {
    sourceSpan?: { start?: { line?: number; col?: number; offset?: number }; end?: { offset?: number } };
  };
  const s = n?.sourceSpan;
  if (!s?.start || s.start.line == null || s.start.col == null) return undefined;
  const startOffset = s.start.offset ?? 0;
  const endOffset = s.end?.offset ?? startOffset;
  return {
    line: s.start.line,
    column: s.start.col,
    length: Math.max(0, endOffset - startOffset),
  };
}

/**
 * Walk an `ASTWithSource` / `AST` expression tree and collect every
 * `BindingPipe` node. Uses the compiler's `RecursiveAstVisitor` so nested
 * pipes, pipes in conditionals, interpolations, method calls, etc. are all
 * covered.
 */
function collectPipes(ast: AST): Array<{ name: string; args: unknown[] }> {
  const found: Array<{ name: string; args: unknown[] }> = [];
  // Lazy: `validate()` guards on availability before any expression reaches
  // this walk, so the compiler is always loaded here.
  const { RecursiveAstVisitor } = requireAngularCompiler();
  const visitor = new (class extends RecursiveAstVisitor {
    override visitPipe(pipe: BindingPipe, context: unknown): unknown {
      found.push({ name: pipe.name, args: pipe.args ?? [] });
      return super.visitPipe(pipe, context);
    }
  })();
  // `ASTWithSource` unwraps to `.ast` for visit; visitor.visit handles both.
  const target = (ast as ASTWithSource).ast ?? ast;
  target.visit(visitor, null);
  return found;
}

// ============================================================================
// Helper Functions (stable public API)
// ============================================================================

export function buildStrictAPIFromAnalysis(component: ComponentAnalysis): StrictComponentAPI {
  return {
    selector: component.metadata.selector ? component.metadata.selector : asSelector(""),
    className: component.className,
    availableInputs: component.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      typeResolved: input.typeResolved,
      required: input.required,
      defaultValue: input.required ? undefined : input.defaultValue,
      description: input.description || `Input property ${input.name}`,
      example: generateInputExample(input.name, input.type),
    })),
    availableOutputs: component.outputs.map((output) => ({
      name: output.name,
      eventType: output.eventType,
      eventTypeResolved: output.eventTypeResolved,
      description: output.description || `Output event ${output.name}`,
      example: `(${output.name})="on${capitalize(output.name)}($event)"`,
    })),
    contentSlots: [],
    requiredProviders: component.metadata.providers || [],
  };
}

export function generateInputExample(name: string, type: string | null): string {
  if (type === null) return `[${name}]="value"`;
  if (type === "boolean") return `[${name}]="true"`;
  if (type === "number") return `[${name}]="10"`;
  if (type === "string") return `${name}="value"`;
  if (type.includes("[]")) return `[${name}]="items"`;
  if (type.includes("Date")) return `[${name}]="today"`;
  return `[${name}]="value"`;
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatValidationResult(result: ValidationResult): string {
  if (result.errors.length === 0) {
    return "✅ Template is valid. All inputs and outputs exist on the specified components.";
  }

  let output = "## ❌ TEMPLATE VALIDATION FAILED\n\nThe following issues were found:\n\n";

  for (const error of result.errors) {
    output += `### ${error.type.toUpperCase()}\n`;
    output += `**Message:** ${error.message}\n`;
    if ("suggestion" in error && error.suggestion) {
      output += `**Suggestion:** ${error.suggestion}\n`;
    }
    output += "\n";
  }

  if (result.warnings.length > 0) {
    output += "## Warnings\n\n";
    for (const warning of result.warnings) {
      output += `- ${warning.message}\n`;
    }
    output += "\n";
  }

  if (result.suggestions.length > 0) {
    output += "## Suggestions\n\n";
    for (const suggestion of result.suggestions) {
      output += `- ${suggestion}\n`;
    }
    output += "\n";
  }

  output += "---\n\n";
  output += "**Action Required:** Fix the template to only use inputs/outputs that exist on the components.\n";

  return output;
}
