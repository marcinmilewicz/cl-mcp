/**
 * JSX Usage Validator
 *
 * React counterpart of the Angular `TemplateValidator`: given a JSX snippet
 * and registered component APIs, flags hallucinated props, missing required
 * props, and offers Levenshtein-based suggestions. Reuses the shared
 * `ValidationResult` / `ValidationError` types so the MCP server formats both
 * frameworks' results identically.
 *
 * Known static-analysis limits (deliberate):
 *   - `{...spread}` props are undecidable — elements carrying a spread skip
 *     the missing-required check and note it in `suggestions`.
 *   - Only PascalCase tags matching a REGISTERED component are validated;
 *     lowercase (DOM) and unregistered tags are ignored, mirroring the
 *     Angular validator's allowlist philosophy.
 */

import ts from "typescript";
import type { FileAnalysis, ValidationError, ValidationResult, ValidationWarning } from "../../types.js";

const MAX_CODE_LENGTH = 100_000;
const MAX_SUGGESTION_DISTANCE = 3;

interface RegisteredComponent {
  name: string;
  inputs: Map<string, { required: boolean; type: string | null }>;
  outputs: Set<string>;
}

export class JsxValidator {
  private readonly registry = new Map<string, RegisteredComponent>();

  /** Register every component found in the given analyses. */
  registerFromAnalysis(analyses: readonly FileAnalysis[]): void {
    for (const analysis of analyses) {
      for (const component of analysis.components) {
        const inputs = new Map<string, { required: boolean; type: string | null }>();
        for (const input of component.inputs) {
          inputs.set(input.alias ?? input.name, { required: input.required, type: input.type });
        }
        const outputs = new Set<string>();
        for (const output of component.outputs) {
          outputs.add(output.alias ?? output.name);
        }
        const entry = { name: component.className, inputs, outputs };
        this.registry.set(component.className, entry);
        // Compound public name (<Dialog.Root>) differs from the declaration
        // name (<DialogRoot>) — JSX may use either, register both.
        const selector = component.metadata.selector;
        if (selector && String(selector) !== String(component.className)) {
          this.registry.set(selector, entry);
        }
      }
    }
  }

  get registeredComponents(): string[] {
    return [...this.registry.keys()];
  }

  validate(code: string): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const suggestions: string[] = [];

    if (code.length > MAX_CODE_LENGTH) {
      return {
        errors: [
          {
            type: "template-too-large",
            message: `Code exceeds ${MAX_CODE_LENGTH} characters and was not validated.`,
            element: "",
          },
        ],
        warnings: [],
        suggestions: [],
      };
    }

    const sourceFile = parseJsxSnippet(code);
    if (!sourceFile) {
      return {
        errors: [],
        warnings: [{ type: "template-parse-failed", message: "Could not parse the snippet as JSX/TSX." }],
        suggestions: [],
      };
    }

    const visit = (node: ts.Node): void => {
      const opening = openingLikeElement(node);
      if (opening) this.validateElement(opening.element, opening.canHaveChildren, sourceFile, errors, suggestions);
      node.forEachChild(visit);
    };
    visit(sourceFile);

    return { errors, warnings, suggestions: [...new Set(suggestions)] };
  }

  private validateElement(
    element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    hasChildren: boolean,
    sourceFile: ts.SourceFile,
    errors: ValidationError[],
    suggestions: string[],
  ): void {
    void hasChildren;
    const tagName = element.tagName.getText(sourceFile);
    // Only validate registered PascalCase components.
    if (!/^[A-Z]/.test(tagName)) return;
    const registered = this.registry.get(tagName);
    if (!registered) return;

    const seen = new Set<string>();
    let hasSpread = false;

    for (const attr of element.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attr)) {
        hasSpread = true;
        continue;
      }
      if (!ts.isJsxAttribute(attr)) continue;
      const attrName = attr.name.getText(sourceFile);
      seen.add(attrName);

      if (registered.inputs.has(attrName) || registered.outputs.has(attrName)) continue;

      const known = [...registered.inputs.keys(), ...registered.outputs];
      const suggestion = closestMatch(attrName, known);
      const span = spanOf(attr, sourceFile);
      const isCallbackish = /^on[A-Z]/.test(attrName);
      errors.push({
        type: isCallbackish ? "unknown-output" : "unknown-input",
        message: `Unknown prop '${attrName}' on <${tagName}>.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
        property: attrName,
        element: tagName,
        suggestion,
        sourceSpan: span,
      });
    }

    if (hasSpread) {
      suggestions.push(
        `<${tagName}> uses a {...spread} — required-prop checks were skipped for it (spread contents are not statically analyzable).`,
      );
    } else {
      for (const [propName, info] of registered.inputs) {
        if (info.required && !seen.has(propName)) {
          errors.push({
            type: "missing-required",
            message: `Required prop '${propName}' is not set on <${tagName}>.`,
            property: propName,
            element: tagName,
            sourceSpan: spanOf(element, sourceFile),
          });
        }
      }
    }
  }
}

// ============================================================================
// Parsing helpers
// ============================================================================

/**
 * Parse a snippet as TSX. Bare multi-root snippets are retried wrapped in a
 * fragment so `<A/><B/>` validates too (spans then point into the wrapper —
 * best effort).
 */
function parseJsxSnippet(code: string): ts.SourceFile | null {
  const attempts = [code, `<>${code}</>`];
  for (const attempt of attempts) {
    const sf = ts.createSourceFile("snippet.tsx", attempt, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const parseDiagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length === 0) return sf;
  }
  return null;
}

function openingLikeElement(
  node: ts.Node,
): { element: ts.JsxOpeningElement | ts.JsxSelfClosingElement; canHaveChildren: boolean } | null {
  if (ts.isJsxElement(node)) return { element: node.openingElement, canHaveChildren: true };
  if (ts.isJsxSelfClosingElement(node)) return { element: node, canHaveChildren: false };
  return null;
}

function spanOf(node: ts.Node, sourceFile: ts.SourceFile): { line: number; column: number; length: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line, column: character, length: node.getWidth(sourceFile) };
}

// ============================================================================
// Suggestions
// ============================================================================

function closestMatch(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= MAX_SUGGESTION_DISTANCE ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prev = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const temp = dist[j];
      dist[j] = Math.min(dist[j] + 1, dist[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return dist[cols - 1];
}
