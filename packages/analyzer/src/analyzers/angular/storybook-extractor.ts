/**
 * Storybook Example Extractor
 * Extracts validated usage examples from Storybook story files.
 *
 * Pattern: Storybook uses wrapper components in story files.
 * The real prefixed component templates are in libs/storybook/src/lib/{component}/stories/*.story.ts
 * not in the main *.stories.ts files.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstElement,
  TmplAstTemplate,
  TmplAstTextAttribute,
} from "@angular/compiler";
import ts from "typescript";
import type { DiagnosticsCollector } from "../../shared/diagnostics.js";
import { type TemplateParseCache, walkTemplate } from "../../shared/template-parser.js";
import { hasExportModifier } from "../../shared/ts-util.js";
import type { StorybookExample } from "../../types.js";
import { asFilePath } from "../../types.js";

/**
 * Internal-only raw template tokens captured during story extraction. Kept in a
 * parallel map (Option A — see plan-2 Commit 4) so `StorybookExample` does not
 * grow a non-serialized field. Populated in Commit 5 when the storybook
 * extractor migrates to the parser walker; today the map stays empty.
 */
export interface RawTemplateTokens {
  elements: string[];
  attributes: string[];
}

// ============================================================================
// Types
// ============================================================================

interface ParsedStory {
  componentName: string;
  selector: string;
  template: string;
}

interface ParsedStoriesMeta {
  title: string;
  stories: Array<{
    name: string;
    args: Record<string, unknown>;
    argTypes?: Record<string, { options?: string[] }>;
    template?: string;
  }>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Main Extractor
// ============================================================================

export class StorybookExtractor {
  private storybookRoot: string;
  private readonly selectorPrefix: string;
  private readonly templateParseCache: TemplateParseCache;
  private readonly diagnostics?: DiagnosticsCollector;
  /**
   * Per-example raw template tokens. Populated by the parser-based walker in
   * `extractUsedComponents`; consumed by the post-pass in
   * `generate-metadata.ts:main()` to resolve attribute-directive co-occurrence
   * edges.
   */
  readonly rawTemplateTokens: Map<StorybookExample, RawTemplateTokens> = new Map();

  constructor(
    storybookRoot: string,
    selectorPrefix = "",
    templateParseCache: TemplateParseCache,
    diagnostics?: DiagnosticsCollector,
  ) {
    this.storybookRoot = storybookRoot;
    this.selectorPrefix = selectorPrefix;
    this.templateParseCache = templateParseCache;
    this.diagnostics = diagnostics;
  }

  /**
   * Extract all Storybook examples for a given component.
   */
  extractStories(componentName: string): StorybookExample[] {
    const examples: StorybookExample[] = [];

    // Look for story files in the storybook lib directory
    const storyDir = path.join(this.storybookRoot, "src/lib", componentName);
    if (!fs.existsSync(storyDir)) {
      // Try with singular/plural variations
      const variations = [
        componentName,
        componentName.replace(/s$/, ""),
        componentName + "s",
        componentName.replace(/-/g, ""),
      ];

      for (const variant of variations) {
        const varDir = path.join(this.storybookRoot, "src/lib", variant);
        if (fs.existsSync(varDir)) {
          return this.extractFromDirectory(varDir);
        }
      }

      return examples;
    }

    return this.extractFromDirectory(storyDir);
  }

  /**
   * Extract stories from a specific directory.
   */
  private extractFromDirectory(dirPath: string): StorybookExample[] {
    const examples: StorybookExample[] = [];

    // 1. Look for individual story files in stories/ subdirectory
    const storiesSubDir = path.join(dirPath, "stories");
    if (fs.existsSync(storiesSubDir)) {
      const storyFiles = fs.readdirSync(storiesSubDir).filter((f) => f.endsWith(".story.ts"));

      for (const storyFile of storyFiles) {
        const filePath = path.join(storiesSubDir, storyFile);
        const parsed = this.parseStoryComponentFile(filePath);

        for (const story of parsed) {
          const template = this.sanitizeTemplate(story.template);
          const example: StorybookExample = {
            storyName: this.storyNameFromFile(storyFile),
            filePath: asFilePath(path.relative(this.storybookRoot, filePath)),
            template,
            args: {},
            usedComponents: [],
          };
          example.usedComponents = this.extractUsedComponents(template, filePath, example);
          examples.push(example);
        }
      }
    }

    // 2. Parse the main *.stories.ts file for args/argTypes and inline templates
    const storiesFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".stories.ts"));

    for (const storiesFile of storiesFiles) {
      const filePath = path.join(dirPath, storiesFile);
      const meta = this.parseStoriesFile(filePath);

      if (meta) {
        // Merge args into story examples
        for (const story of meta.stories) {
          // Check if there's an inline template in stories.ts
          if (story.template) {
            const prefixedTemplate = this.extractPrefixedTemplate(story.template);
            if (prefixedTemplate) {
              const template = this.sanitizeTemplate(prefixedTemplate);
              const example: StorybookExample = {
                storyName: story.name,
                filePath: asFilePath(path.relative(this.storybookRoot, filePath)),
                template,
                args: story.args || {},
                argTypes: story.argTypes,
                usedComponents: [],
              };
              example.usedComponents = this.extractUsedComponents(template, filePath, example);
              examples.push(example);
            }
          }

          // Enrich existing examples with args from stories.ts
          const matchingExample = examples.find(
            (e) => this.normalizeStoryName(e.storyName) === this.normalizeStoryName(story.name),
          );
          if (matchingExample && Object.keys(story.args).length > 0) {
            matchingExample.args = { ...matchingExample.args, ...story.args };
            if (story.argTypes) {
              matchingExample.argTypes = story.argTypes;
            }
          }
        }
      }
    }

    return examples;
  }

  /**
   * Parse a *.story.ts file that contains a wrapper @Component with template.
   */
  parseStoryComponentFile(filePath: string): ParsedStory[] {
    const stories: ParsedStory[] = [];
    const sourceCode = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ES2022, true);

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isClassDeclaration(node)) return;
      const decorators = ts.getDecorators(node);
      if (!decorators) return;

      for (const decorator of decorators) {
        const expr = decorator.expression;
        if (!ts.isCallExpression(expr)) continue;
        if (expr.expression.getText(sourceFile) !== "Component") continue;
        if (expr.arguments.length === 0) continue;

        const arg = expr.arguments[0];
        if (!ts.isObjectLiteralExpression(arg)) continue;

        let template = "";
        let selector = "";

        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          const key = prop.name.getText(sourceFile);

          if (key === "template") {
            template = this.extractTemplateString(prop.initializer, sourceFile);
          } else if (key === "selector") {
            selector = ts.isStringLiteral(prop.initializer) ? prop.initializer.text : "";
          }
        }

        if (template) {
          stories.push({
            componentName: node.name?.getText(sourceFile) || "",
            selector,
            template,
          });
        }
      }
    });

    return stories;
  }

  /**
   * Parse the main *.stories.ts file for args, argTypes.
   */
  parseStoriesFile(filePath: string): ParsedStoriesMeta | null {
    const sourceCode = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ES2022, true);

    let title = "";
    const stories: ParsedStoriesMeta["stories"] = [];

    ts.forEachChild(sourceFile, (node) => {
      // Find default export for meta: export default { title: '...' } or export default { ... } as Meta
      if (ts.isExportAssignment(node)) {
        const objLiteral = this.unwrapToObjectLiteral(node.expression);
        if (objLiteral) {
          for (const prop of objLiteral.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.getText(sourceFile) === "title" &&
              ts.isStringLiteral(prop.initializer)
            ) {
              title = prop.initializer.text;
            }
          }
        }
      }

      // Find "export default { title: ... }" via variable statement (e.g. const meta = { title: '...' } satisfies Meta)
      if (ts.isVariableStatement(node) && !title) {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
            for (const prop of decl.initializer.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.getText(sourceFile) === "title" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                title = prop.initializer.text;
              }
            }
          }
          // Handle: { title: '...' } satisfies Meta (TS 4.9+)
          if (
            decl.initializer &&
            ts.isSatisfiesExpression(decl.initializer) &&
            ts.isObjectLiteralExpression(decl.initializer.expression)
          ) {
            for (const prop of decl.initializer.expression.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.getText(sourceFile) === "title" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                title = prop.initializer.text;
              }
            }
          }
          // Handle: { title: '...' } as Meta (type assertion)
          if (
            decl.initializer &&
            ts.isAsExpression(decl.initializer) &&
            ts.isObjectLiteralExpression(decl.initializer.expression)
          ) {
            for (const prop of decl.initializer.expression.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.getText(sourceFile) === "title" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                title = prop.initializer.text;
              }
            }
          }
        }
      }

      // Find exported story objects: export const Button = { ... }
      if (ts.isVariableStatement(node) && hasExportModifier(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;

          const storyName = decl.name.getText(sourceFile);
          if (storyName === "default") continue;

          const story: ParsedStoriesMeta["stories"][0] = {
            name: storyName,
            args: {},
          };

          for (const prop of decl.initializer.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            const key = prop.name.getText(sourceFile);

            if (key === "args" && ts.isObjectLiteralExpression(prop.initializer)) {
              story.args = this.extractSimpleObject(prop.initializer, sourceFile);
            } else if (key === "argTypes" && ts.isObjectLiteralExpression(prop.initializer)) {
              story.argTypes = this.extractArgTypes(prop.initializer, sourceFile);
            } else if (key === "render") {
              // Try to extract template from render function
              const template = this.extractTemplateFromRender(prop.initializer, sourceFile);
              if (template) story.template = template;
            }
          }

          stories.push(story);
        }
      }
    });

    if (!title && stories.length === 0) return null;

    return { title, stories };
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private extractTemplateString(node: ts.Expression, sourceFile: ts.SourceFile): string {
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isStringLiteral(node)) {
      return node.text;
    }
    if (ts.isTemplateExpression(node)) {
      // For template expressions, return the raw text (may contain ${} expressions)
      return node.getText(sourceFile).replace(/^`|`$/g, "");
    }
    return "";
  }

  private extractPrefixedTemplate(template: string): string | null {
    if (!this.selectorPrefix) return template.trim() || null;

    // Walk the template manually, tracking nesting depth for same-prefix tags
    // so the outer element is returned intact (bug L5: nested same-prefix tags
    // used to truncate at the first inner close tag).
    const prefix = this.selectorPrefix;
    const p = escapeRegex(prefix);
    const openTagRe = new RegExp(`<${p}[\\w-]+`);
    const firstOpen = openTagRe.exec(template);
    if (!firstOpen) {
      if (template.trim().startsWith(`<${prefix}`)) return template.trim();
      return null;
    }

    const start = firstOpen.index;
    const tagRe = new RegExp(`<(\\/?)${p}[\\w-]+[^>]*?(\\/?)>`, "g");
    tagRe.lastIndex = start;
    let depth = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(template)) !== null) {
      const isClose = m[1] === "/";
      const isSelfClose = m[2] === "/";
      if (isClose) {
        depth--;
        if (depth === 0) return template.slice(start, m.index + m[0].length);
      } else if (isSelfClose) {
        if (depth === 0) return template.slice(start, m.index + m[0].length);
      } else {
        depth++;
      }
    }

    return template.slice(start).trim() || null;
  }

  /**
   * AST-based replacement for the legacy regex. Populates
   * `this.rawTemplateTokens` with {elements, attributes} used by the resolve
   * pass in `generate-metadata.ts`. Returns the prefix-filtered element list as
   * a back-compat safety net; the CLI post-pass is the sole writer of the real
   * `usedComponents` after selector-map resolution.
   */
  private extractUsedComponents(template: string, sourceUrl: string, example: StorybookExample): string[] {
    const elementsSet = new Set<string>();
    const attributesSet = new Set<string>();

    const collectFromAttrs = (
      attrs: ReadonlyArray<TmplAstTextAttribute | TmplAstBoundAttribute | TmplAstBoundEvent>,
    ) => {
      for (const a of attrs) attributesSet.add(a.name);
    };

    let walked = false;
    try {
      const parsed = this.templateParseCache.get(template, sourceUrl);
      const errors = parsed.errors ?? [];
      const hasErrors = errors.length > 0;
      const hasNodes = Array.isArray(parsed.nodes) && parsed.nodes.length > 0;

      if (!hasNodes && hasErrors) {
        // No recovered AST — actual metadata lost. Elevate to error severity.
        this.diagnostics?.push({
          severity: "error",
          code: "template-parse-failed",
          file: sourceUrl,
          message: `Failed to parse storybook template: ${errors
            .slice(0, 3)
            .map((e) => e.msg ?? String(e))
            .join("; ")}`,
        });
      } else {
        if (hasErrors) {
          this.diagnostics?.push({
            severity: "warn",
            code: "template-parse-failed",
            file: sourceUrl,
            message: `Partial parse for storybook template (${errors.length} error(s)); continuing with AST.`,
          });
        }
        walkTemplate(parsed.nodes, {
          visitElement: (el: TmplAstElement) => {
            elementsSet.add(el.name);
            collectFromAttrs(el.attributes);
            collectFromAttrs(el.inputs);
            collectFromAttrs(el.outputs);
          },
          visitTemplate: (tpl: TmplAstTemplate) => {
            for (const a of (tpl.templateAttrs ?? []) as Array<TmplAstTextAttribute | TmplAstBoundAttribute>) {
              attributesSet.add(a.name);
            }
            collectFromAttrs(tpl.attributes);
            collectFromAttrs(tpl.inputs);
            collectFromAttrs(tpl.outputs);
          },
        });
        walked = true;
      }
    } catch (err) {
      this.diagnostics?.push({
        severity: "warn",
        code: "template-parse-failed",
        file: sourceUrl,
        message: `Template parse threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!walked) {
      if (this.selectorPrefix) {
        const regex = new RegExp(`<(${escapeRegex(this.selectorPrefix)}[\\w-]+)`, "g");
        let m: RegExpExecArray | null;
        while ((m = regex.exec(template)) !== null) {
          elementsSet.add(m[1]);
        }
      }
    }

    const tokens = {
      elements: Array.from(elementsSet),
      attributes: Array.from(attributesSet),
    };
    this.rawTemplateTokens.set(example, tokens);

    return tokens.elements;
  }

  private extractSimpleObject(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = prop.name.getText(sourceFile);
      const init = prop.initializer;

      if (ts.isStringLiteral(init)) result[key] = init.text;
      else if (ts.isNumericLiteral(init)) result[key] = Number(init.text);
      else if (init.kind === ts.SyntaxKind.TrueKeyword) result[key] = true;
      else if (init.kind === ts.SyntaxKind.FalseKeyword) result[key] = false;
      else result[key] = init.getText(sourceFile);
    }
    return result;
  }

  private extractArgTypes(
    node: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
  ): Record<string, { options?: string[] }> {
    const result: Record<string, { options?: string[] }> = {};

    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const key = prop.name.getText(sourceFile);

      if (ts.isObjectLiteralExpression(prop.initializer)) {
        const argType: { options?: string[] } = {};

        for (const inner of prop.initializer.properties) {
          if (!ts.isPropertyAssignment(inner) || !ts.isIdentifier(inner.name)) continue;
          const innerKey = inner.name.getText(sourceFile);

          if (innerKey === "options" && ts.isArrayLiteralExpression(inner.initializer)) {
            argType.options = inner.initializer.elements
              .filter((el): el is ts.StringLiteral => ts.isStringLiteral(el))
              .map((el) => el.text);
          }
        }

        if (argType.options) {
          result[key] = argType;
        }
      }
    }

    return result;
  }

  private extractTemplateFromRender(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
    // Traverse the render function body to find: template: `...` or template: '...'
    const templateValue = this.findTemplatePropertyInExpression(node, sourceFile);
    return templateValue;
  }

  /**
   * Recursively search an expression for an object literal with a 'template' property.
   * Handles: (args) => ({ template: `...` }), function(args) { return { template: '...' } }
   */
  private findTemplatePropertyInExpression(node: ts.Node, sourceFile: ts.SourceFile): string | null {
    // Direct object literal with 'template' property
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.getText(sourceFile) === "template"
        ) {
          return this.extractTemplateString(prop.initializer, sourceFile) || null;
        }
      }
    }

    // Arrow function: (args) => ({ template: `...` })
    if (ts.isArrowFunction(node)) {
      if (ts.isParenthesizedExpression(node.body)) {
        return this.findTemplatePropertyInExpression(node.body.expression, sourceFile);
      }
      if (ts.isBlock(node.body)) {
        for (const stmt of node.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression) {
            return this.findTemplatePropertyInExpression(stmt.expression, sourceFile);
          }
        }
      }
      return this.findTemplatePropertyInExpression(node.body, sourceFile);
    }

    // Function expression
    if (ts.isFunctionExpression(node) && node.body) {
      for (const stmt of node.body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) {
          return this.findTemplatePropertyInExpression(stmt.expression, sourceFile);
        }
      }
    }

    return null;
  }

  /**
   * Unwrap type assertions/satisfies to get the underlying ObjectLiteralExpression.
   */
  private unwrapToObjectLiteral(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isAsExpression(node)) return this.unwrapToObjectLiteral(node.expression);
    if (ts.isSatisfiesExpression(node)) return this.unwrapToObjectLiteral(node.expression);
    if (ts.isParenthesizedExpression(node)) return this.unwrapToObjectLiteral(node.expression);
    return undefined;
  }

  private storyNameFromFile(filename: string): string {
    let base = filename.replace(".story.ts", "");
    // Strip ONLY the configured selector prefix, NOT a greedy leading-component-name
    // strip — otherwise multi-segment names like 'button-with-icon' collapse to 'Icon'.
    if (this.selectorPrefix && base.startsWith(this.selectorPrefix)) {
      base = base.slice(this.selectorPrefix.length);
    }
    return base.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private normalizeStoryName(name: string): string {
    return name.toLowerCase().replace(/[-_\s]/g, "");
  }

  /**
   * Strip storybook-only pseudo-attributes (e.g. sbFs="hover") from templates.
   * These are used for forcing CSS pseudo-states in visual testing and are not valid Angular bindings.
   */
  private sanitizeTemplate(template: string): string {
    return template.replace(/ sbFs="[^"]*"/g, "");
  }
}

/**
 * Get all component directories in storybook that have stories
 */
export function getStorybookComponents(storybookRoot: string): string[] {
  const libDir = path.join(storybookRoot, "src/lib");
  if (!fs.existsSync(libDir)) return [];

  return fs
    .readdirSync(libDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
