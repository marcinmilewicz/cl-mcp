/**
 * React Storybook (CSF) Extractor — best effort.
 *
 * Parses `*.stories.tsx?` files in Component Story Format:
 *   - `export default { title, component: Button }` (or `const meta = {...};
 *     export default meta`) → owning component.
 *   - each named export → one `StorybookExample` with `args` (literal-evaluated)
 *     and, when a `render` function is present, its JSX text as `template`.
 *
 * CSF3 stories frequently have NO render function (implicit render) — those
 * still yield args/argTypes but contribute no `usedComponents`, so React
 * co-occurrence edges are inherently sparser than Angular's. This is a known,
 * accepted limitation (documented in the architecture plan).
 */

import ts from "typescript";
import { evaluateExpression } from "../../shared/ts-util.js";
import type { StorybookExample } from "../../types.js";
import { asFilePath } from "../../types.js";

export interface ReactStoryExtraction {
  /** Component name from `meta.component`, when statically visible. */
  componentName?: string;
  examples: StorybookExample[];
  /** Raw PascalCase JSX tags per example, resolved against the library later. */
  rawJsxTags: Map<StorybookExample, string[]>;
}

export function extractReactStories(sourceFile: ts.SourceFile): ReactStoryExtraction {
  const examples: StorybookExample[] = [];
  const rawJsxTags = new Map<StorybookExample, string[]>();

  const metaObject = findMetaObject(sourceFile);
  const componentName = metaObject ? identifierOfProperty(metaObject, "component") : undefined;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const storyName = decl.name.getText(sourceFile);
      // `const meta = {...}` default-export holders are not stories.
      if (storyName === "meta") continue;

      const story = ts.isObjectLiteralExpression(decl.initializer) ? decl.initializer : null;
      if (!story) continue;

      const argsExpr = propertyInitializer(story, "args");
      const args =
        argsExpr && ts.isObjectLiteralExpression(argsExpr)
          ? ((evaluateExpression(argsExpr) as Record<string, unknown>) ?? {})
          : {};

      const renderExpr = propertyInitializer(story, "render");
      const template = renderExpr ? jsxTextOf(renderExpr, sourceFile) : "";

      const example: StorybookExample = {
        storyName,
        filePath: asFilePath(sourceFile.fileName),
        template,
        args,
        usedComponents: [],
      };
      examples.push(example);
      rawJsxTags.set(example, renderExpr ? collectJsxTags(renderExpr, sourceFile) : []);
    }
  }

  return { componentName, examples, rawJsxTags };
}

// ============================================================================
// Helpers
// ============================================================================

/** `export default {...}` or `export default meta` (following the local const). */
function findMetaObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    let expr: ts.Expression = statement.expression;
    if (ts.isSatisfiesExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;

    if (ts.isObjectLiteralExpression(expr)) return expr;
    if (ts.isIdentifier(expr)) {
      const target = expr.getText(sourceFile);
      for (const s of sourceFile.statements) {
        if (!ts.isVariableStatement(s)) continue;
        for (const decl of s.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.getText(sourceFile) === target && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            if (ts.isSatisfiesExpression(init) || ts.isAsExpression(init)) init = init.expression;
            if (ts.isObjectLiteralExpression(init)) return init;
          }
        }
      }
    }
  }
  return null;
}

function propertyInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === name) return prop.initializer;
  }
  return null;
}

function identifierOfProperty(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  const init = propertyInitializer(obj, name);
  return init && ts.isIdentifier(init) ? init.getText() : undefined;
}

/** The JSX returned by a render function, as source text (empty when none). */
function jsxTextOf(renderExpr: ts.Expression, sourceFile: ts.SourceFile): string {
  let jsx = "";
  const visit = (node: ts.Node): void => {
    if (jsx) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      jsx = node.getText(sourceFile);
      return;
    }
    node.forEachChild(visit);
  };
  visit(renderExpr);
  return jsx;
}

/** All PascalCase JSX tag names under a node (deduped, document order). */
export function collectJsxTags(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const tags: string[] = [];
  const visit = (n: ts.Node): void => {
    let tagName: string | null = null;
    if (ts.isJsxSelfClosingElement(n)) tagName = n.tagName.getText(sourceFile);
    else if (ts.isJsxElement(n)) tagName = n.openingElement.tagName.getText(sourceFile);
    if (tagName && /^[A-Z]/.test(tagName) && !tags.includes(tagName)) tags.push(tagName);
    n.forEachChild(visit);
  };
  visit(node);
  return tags;
}
