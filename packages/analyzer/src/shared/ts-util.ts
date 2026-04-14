/**
 * Shared TypeScript AST helpers used across the analyzer package.
 *
 * Phase 6: these replace near-duplicate implementations that used to live in
 * angular-analyzer.ts, storybook-extractor.ts, and generate-metadata.ts. Keep
 * the surface small and well-documented — every caller should be able to drop
 * its local copy and import from here instead.
 */

import ts from "typescript";

/**
 * Extract the JSDoc description text from a node's leading block comment.
 *
 * Only considers the first JSDoc-style (`/** ... *\/`) leading comment. Tag
 * lines (those starting with `@`) are stripped so only the free-text
 * description survives. Returns `undefined` when no description is present.
 */
export function extractJsDocComment(node: ts.Node): string | undefined {
  const sourceFile = node.getSourceFile();
  if (!sourceFile) return undefined;
  const fullText = sourceFile.getFullText();
  const leadingComments = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!leadingComments) return undefined;

  const descriptions: string[] = [];
  for (const comment of leadingComments) {
    if (comment.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const text = fullText.slice(comment.pos, comment.end);
    if (!text.startsWith("/**")) continue;

    const lines = text
      .replace(/^\/\*\*\s*/, "")
      .replace(/\s*\*\/$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => !line.startsWith("@"));

    const description = lines.join(" ").trim();
    if (description) descriptions.push(description);
  }

  return descriptions.length > 0 ? descriptions.join("\n") : undefined;
}

/**
 * Extract the identifier name of a decorator, handling both call-style
 * (`@Foo(...)`) and bare (`@Foo`) forms. Returns `undefined` if the decorator
 * expression is something exotic we don't recognize as a name.
 */
export function getDecoratorName(decorator: ts.Decorator): string | undefined {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression)) {
    const text = expression.expression.getText();
    return text || undefined;
  }
  const text = expression.getText();
  return text || undefined;
}

/**
 * Extract the first type argument from a type reference node that matches
 * `typeName` (e.g. `EventEmitter<string>` → returns the `string` type node
 * when `typeName === "EventEmitter"`).
 *
 * If `typeName` is the empty string, matches any type reference — useful when
 * the caller only cares about "first type arg of any type ref".
 */
export function extractTypeArgFromTypeNode(typeNode: ts.TypeNode, typeName: string): ts.TypeNode | undefined {
  if (!ts.isTypeReferenceNode(typeNode)) return undefined;
  if (typeName) {
    const refName = typeNode.typeName.getText();
    if (refName !== typeName) return undefined;
  }
  if (!typeNode.typeArguments || typeNode.typeArguments.length === 0) return undefined;
  return typeNode.typeArguments[0];
}

/**
 * Evaluate an expression at "analyzer-time" — a hardened literal evaluator
 * that handles primitives, arrays, and object literals. For anything more
 * exotic (identifiers, calls, template expressions) we fall back to the raw
 * source text so the caller can at least preserve a printable form.
 */
export function evaluateExpression(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((el) => evaluateExpression(el));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = prop.name.getText();
        obj[key] = evaluateExpression(prop.initializer);
      }
    }
    return obj;
  }
  return node.getText();
}

/**
 * Does this node carry an `export` modifier? Uses the modern `ts.getModifiers`
 * API (pre-4.8 decorator/modifier merging is out of scope).
 */
export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Extract the string value from a template-shaped expression:
 *   'foo' | "foo" | `foo` (no-substitution template literal)
 *
 * Template expressions with interpolations are NOT handled here (caller-
 * specific logic decides whether to stringify or reject them).
 */
export function extractTemplateString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}
