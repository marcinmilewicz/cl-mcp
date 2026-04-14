/**
 * Thin wrapper around `@angular/compiler`'s `parseTemplate`.
 *
 * Provides three primitives that the analyzer's three template-consuming
 * call-sites (ng-content extraction, template validator, storybook used-component
 * extraction) will share:
 *
 * 1. `parseAngularTemplate(template, sourceUrl, opts?)` — fixed options, the
 *    canonical entry point. Returns `ParsedTemplate` as-is from the compiler;
 *    callers inspect `.nodes` and `.errors` themselves.
 * 2. `TemplateParseCache` — memoises parses keyed by `sha1(template) + '|' + sourceUrl`
 *    so the same template text/URL pair parses exactly once per analyzer run and
 *    subsequent `get()` calls return identical references.
 * 3. `walkTemplate(nodes, visitor)` — recursive walker that descends into every
 *    Angular 17+ control-flow branch plus legacy structural constructs. Keeps
 *    visitor callbacks optional and side-effect free so each call-site can opt in
 *    only to the node kinds it cares about.
 *
 * No call-site consumes this yet (Commit 1 lands infrastructure only).
 */

import { createHash } from "node:crypto";
import {
  type TmplAstBoundText,
  type TmplAstContent,
  type TmplAstDeferredBlock,
  type TmplAstElement,
  type TmplAstForLoopBlock,
  type TmplAstIcu,
  type TmplAstIfBlock,
  type TmplAstLetDeclaration,
  type TmplAstNode,
  type TmplAstSwitchBlock,
  type TmplAstTemplate,
  type TmplAstText,
  type TmplAstUnknownBlock,
  parseTemplate,
} from "@angular/compiler";

// `ParsedTemplate` is not exported as a type alias from the package root, but
// it is the concrete return type of `parseTemplate`. We extract it structurally
// so downstream code can name it.
export type ParsedTemplate = ReturnType<typeof parseTemplate>;

export interface ParseAngularTemplateOptions {
  /**
   * Passed through to `parseTemplate`. If omitted, the defaults below apply.
   * Callers that need different whitespace behaviour must pass explicit values
   * — the cache key does NOT factor in options, so mixing option sets on the
   * same `(template, sourceUrl)` pair would produce stale cache hits. See
   * `TemplateParseCache`.
   */
  readonly preserveWhitespaces?: boolean;
  readonly preserveLineEndings?: boolean;
  readonly alwaysAttemptHtmlToR3AstConversion?: boolean;
}

const DEFAULT_OPTIONS = {
  preserveWhitespaces: false,
  preserveLineEndings: true,
  alwaysAttemptHtmlToR3AstConversion: true,
} as const;

/**
 * Parse an Angular template string into its R3 AST. Thin wrapper; callers
 * inspect `.nodes` and `.errors` on the result themselves.
 */
export function parseAngularTemplate(
  template: string,
  sourceUrl: string,
  opts: ParseAngularTemplateOptions = {},
): ParsedTemplate {
  return parseTemplate(template, sourceUrl, {
    preserveWhitespaces: opts.preserveWhitespaces ?? DEFAULT_OPTIONS.preserveWhitespaces,
    preserveLineEndings: opts.preserveLineEndings ?? DEFAULT_OPTIONS.preserveLineEndings,
    alwaysAttemptHtmlToR3AstConversion:
      opts.alwaysAttemptHtmlToR3AstConversion ?? DEFAULT_OPTIONS.alwaysAttemptHtmlToR3AstConversion,
  });
}

/**
 * Memoises parses keyed by `sha1(template) + '|' + sourceUrl`. Guarantees that
 * two `get()` calls with identical args return the same object reference, so
 * downstream walkers can rely on identity across call-sites.
 */
export class TemplateParseCache {
  private readonly entries = new Map<string, ParsedTemplate>();

  get(template: string, sourceUrl: string, opts?: ParseAngularTemplateOptions): ParsedTemplate {
    const key = `${createHash("sha1").update(template).digest("hex")}|${sourceUrl}`;
    const hit = this.entries.get(key);
    if (hit) return hit;
    const parsed = parseAngularTemplate(template, sourceUrl, opts);
    this.entries.set(key, parsed);
    return parsed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// ============================================================================
// Walker
// ============================================================================

export interface TemplateVisitor {
  visitElement?(node: TmplAstElement): void;
  visitTemplate?(node: TmplAstTemplate): void;
  visitContent?(node: TmplAstContent): void;
  visitText?(node: TmplAstText): void;
  visitBoundText?(node: TmplAstBoundText): void;
  visitIcu?(node: TmplAstIcu): void;
  visitIfBlock?(node: TmplAstIfBlock): void;
  visitForLoopBlock?(node: TmplAstForLoopBlock): void;
  visitSwitchBlock?(node: TmplAstSwitchBlock): void;
  visitDeferredBlock?(node: TmplAstDeferredBlock): void;
  visitUnknownBlock?(node: TmplAstUnknownBlock): void;
  visitLetDeclaration?(node: TmplAstLetDeclaration): void;
}

/**
 * Recursively walk template nodes, invoking visitor callbacks on enter. The
 * walker descends into every container the plan enumerates:
 * - `TmplAstElement.children`
 * - `TmplAstTemplate.children` AND `.templateAttrs` (as an array of attr nodes —
 *   templateAttrs are TextAttribute / BoundAttribute, no children to recurse
 *   into, but they are visited as leaves so walkers can observe structural
 *   directives like `*ngFor`)
 * - `TmplAstIfBlock.branches[].children`
 * - `TmplAstForLoopBlock.children` + `.empty?.children`
 * - `TmplAstSwitchBlock.cases[].children`
 * - `TmplAstDeferredBlock.children` + `.placeholder?.children` + `.loading?.children` + `.error?.children`
 */
export function walkTemplate(nodes: readonly TmplAstNode[] | undefined, visitor: TemplateVisitor): void {
  if (!nodes) return;
  for (const node of nodes) {
    visit(node, visitor);
  }
}

function visit(node: TmplAstNode, v: TemplateVisitor): void {
  // Structural discrimination without `instanceof` — @angular/compiler nodes
  // don't expose a discriminator field, so we duck-type on the properties we
  // recurse into. Each branch also fires the typed visitor callback.
  //
  // Order matters: more-specific guards (Template with templateAttrs, Content
  // named "ng-content") MUST run before the general Element guard.
  const n = node as unknown as Record<string, unknown>;

  // ng-template — has `templateAttrs` array AND `children`. Checked first
  // because `isElement` would otherwise match.
  if (isTemplate(n)) {
    const tpl = node as TmplAstTemplate;
    v.visitTemplate?.(tpl);
    walkTemplate(tpl.children, v);
    // templateAttrs are leaf attribute nodes — no children to recurse into.
    return;
  }

  // ng-content — `name === "ng-content"`, also has `children` (fallback content
  // when no matching projected content). Checked before Element because Element
  // would match on `name` + `children`.
  if (isContent(n)) {
    v.visitContent?.(node as TmplAstContent);
    walkTemplate((node as unknown as { children?: readonly TmplAstNode[] }).children, v);
    return;
  }

  // Element: has `children` and `inputs`/`outputs`/`attributes`.
  if (isElement(n)) {
    v.visitElement?.(node as TmplAstElement);
    walkTemplate((node as TmplAstElement).children, v);
    return;
  }

  if (isIfBlock(n)) {
    const ifb = node as TmplAstIfBlock;
    v.visitIfBlock?.(ifb);
    for (const branch of ifb.branches ?? []) {
      walkTemplate(branch.children, v);
    }
    return;
  }

  if (isForLoopBlock(n)) {
    const f = node as TmplAstForLoopBlock;
    v.visitForLoopBlock?.(f);
    walkTemplate(f.children, v);
    if (f.empty) walkTemplate(f.empty.children, v);
    return;
  }

  if (isSwitchBlock(n)) {
    const s = node as TmplAstSwitchBlock;
    v.visitSwitchBlock?.(s);
    for (const c of s.cases ?? []) {
      walkTemplate(c.children, v);
    }
    return;
  }

  if (isDeferredBlock(n)) {
    const d = node as TmplAstDeferredBlock;
    v.visitDeferredBlock?.(d);
    walkTemplate(d.children, v);
    if (d.placeholder) walkTemplate(d.placeholder.children, v);
    if (d.loading) walkTemplate(d.loading.children, v);
    if (d.error) walkTemplate(d.error.children, v);
    return;
  }

  if (isBoundText(n)) {
    v.visitBoundText?.(node as TmplAstBoundText);
    return;
  }

  if (isText(n)) {
    v.visitText?.(node as TmplAstText);
    return;
  }

  if (isIcu(n)) {
    v.visitIcu?.(node as TmplAstIcu);
    return;
  }

  if (isLetDeclaration(n)) {
    v.visitLetDeclaration?.(node as TmplAstLetDeclaration);
    return;
  }

  if (isUnknownBlock(n)) {
    v.visitUnknownBlock?.(node as TmplAstUnknownBlock);
    return;
  }
}

// ---- duck-type guards ----------------------------------------------------

// Element has `name`, `children`, `inputs`, `outputs`, `attributes`.
// Template has `templateAttrs`, distinguishes it from Element.
function isElement(n: Record<string, unknown>): boolean {
  return (
    typeof n.name === "string" &&
    Array.isArray(n.children) &&
    Array.isArray(n.inputs) &&
    Array.isArray(n.outputs) &&
    Array.isArray(n.attributes) &&
    !Array.isArray(n.templateAttrs)
  );
}

function isTemplate(n: Record<string, unknown>): boolean {
  return Array.isArray(n.children) && Array.isArray(n.templateAttrs);
}

function isIfBlock(n: Record<string, unknown>): boolean {
  return Array.isArray(n.branches);
}

function isForLoopBlock(n: Record<string, unknown>): boolean {
  // `item` is a TmplAstVariable on ForLoopBlock specifically; combined with
  // `children` and `trackBy`/`expression` presence it's unambiguous.
  return (
    Array.isArray(n.children) && "item" in n && "expression" in n && !Array.isArray((n as { cases?: unknown }).cases)
  );
}

function isSwitchBlock(n: Record<string, unknown>): boolean {
  return Array.isArray(n.cases);
}

function isDeferredBlock(n: Record<string, unknown>): boolean {
  return Array.isArray(n.children) && ("placeholder" in n || "loading" in n || "error" in n) && "triggers" in n;
}

function isContent(n: Record<string, unknown>): boolean {
  // ng-content — has `selector` (string, default "*") and `name` === "ng-content".
  return n.name === "ng-content" || (typeof n.selector === "string" && "selectorIndex" in n);
}

function isBoundText(n: Record<string, unknown>): boolean {
  return "value" in n && typeof n.value === "object" && n.value !== null && !("name" in n);
}

function isText(n: Record<string, unknown>): boolean {
  return typeof n.value === "string" && !("expression" in n);
}

function isIcu(n: Record<string, unknown>): boolean {
  return "vars" in n && "placeholders" in n;
}

function isLetDeclaration(n: Record<string, unknown>): boolean {
  return (
    "value" in n &&
    "name" in n &&
    typeof n.name === "string" &&
    "nameSpan" in n &&
    !("children" in n) &&
    !("selector" in n)
  );
}

function isUnknownBlock(n: Record<string, unknown>): boolean {
  return (
    "name" in n &&
    typeof n.name === "string" &&
    !Array.isArray((n as { children?: unknown }).children) &&
    !("value" in n)
  );
}
