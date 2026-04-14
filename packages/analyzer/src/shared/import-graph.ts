/**
 * Import Graph & Relationship Analyzer
 * Automatically detects relationships between components by analyzing imports.
 * Replaces manual dependencies.ts with auto-detected data (with manual override support).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ImportGraphEntry, Mutable, RelatedComponent } from "../types.js";

// ============================================================================
// Import Graph Builder
// ============================================================================

/**
 * Internal utility / non-component subpackages that must never surface as a
 * user-facing sibling in `related` / `requires` output. Kept centralized so
 * both `findRelatedComponents` and `resolveDependencies` share the same
 * ignore-set (bug M6: 'theming' and 'prebuilt-themes' used to leak through).
 */
const NON_COMPONENT_SUBPACKAGES: ReadonlySet<string> = new Set([
  "core",
  "cdk",
  "theming",
  "prebuilt-themes",
  "schematics",
  "testing",
]);

export interface ImportGraph {
  entries: Map<string, ImportGraphEntry>;
}

/**
 * Build an import graph from all component files.
 * Scans import statements to detect which components import from others.
 */
export function buildImportGraph(componentsPath: string, importPrefix = ""): ImportGraph {
  const graph: ImportGraph = { entries: new Map() };
  const componentDirs = getComponentDirectories(componentsPath);

  for (const componentName of componentDirs) {
    const entry: Mutable<ImportGraphEntry> = {
      component: componentName,
      imports: [],
      importedBy: [],
    };

    const componentDir = path.join(componentsPath, componentName);
    const tsFiles = getTsFiles(componentDir);

    for (const tsFile of tsFiles) {
      const imports = extractImportsFromFile(tsFile, componentsPath, importPrefix);
      for (const imp of imports) {
        if (imp !== componentName && !entry.imports.includes(imp)) {
          entry.imports.push(imp);
        }
      }
    }

    graph.entries.set(componentName, entry);
  }

  // Build reverse index (importedBy)
  for (const [componentName, entry] of graph.entries) {
    for (const importedComponent of entry.imports) {
      const importedEntry = graph.entries.get(importedComponent) as Mutable<ImportGraphEntry> | undefined;
      if (importedEntry && !importedEntry.importedBy.includes(componentName)) {
        importedEntry.importedBy.push(componentName);
      }
    }
  }

  return graph;
}

/**
 * Find related components for a given component.
 * Combines auto-detected relationships with manual overrides.
 */
export function findRelatedComponents(
  componentName: string,
  graph: ImportGraph,
  storybookCooccurrences?: Map<string, string[]>,
): RelatedComponent[] {
  const related: RelatedComponent[] = [];
  const entry = graph.entries.get(componentName);
  if (!entry) return related;

  // 1. "requires" - direct imports
  for (const imp of entry.imports) {
    // Skip core/internal imports that aren't user-facing components
    if (NON_COMPONENT_SUBPACKAGES.has(imp)) continue;

    related.push({
      name: imp,
      relationship: "requires",
      reason: `Imported by ${componentName}`,
    });
  }

  // 2. "often-used-with" - co-occurrence in Storybook
  if (storybookCooccurrences) {
    const cooccurrences = storybookCooccurrences.get(componentName) || [];
    for (const coComponent of cooccurrences) {
      // Skip if already listed as requires
      if (related.some((r) => r.name === coComponent)) continue;

      related.push({
        name: coComponent,
        relationship: "often-used-with",
        reason: "Used together in Storybook stories",
      });
    }
  }

  return related;
}

/**
 * Resolve dependencies for a component from the import graph.
 * All dependencies are auto-detected from actual import statements.
 */
export function resolveDependencies(
  componentName: string,
  graph: ImportGraph,
): { required: string[]; optional: string[]; providers: { required: string[]; optional: string[] } } {
  const autoDetected = graph.entries.get(componentName);

  const optional: string[] = [];
  if (autoDetected) {
    for (const imp of autoDetected.imports) {
      if (NON_COMPONENT_SUBPACKAGES.has(imp)) continue;
      optional.push(imp);
    }
  }

  return {
    required: [],
    optional: [...new Set(optional)],
    providers: { required: [], optional: [] },
  };
}

/**
 * Build co-occurrence map from Storybook templates.
 * Which prefixed components appear together in the same template?
 */
export function buildStorybookCooccurrences(
  storybookExamples: Map<string, Array<{ usedComponents: string[] }>>,
  selectorPrefix = "",
): Map<string, string[]> {
  const cooccurrences = new Map<string, Set<string>>();
  const stripPrefix = (s: string): string =>
    selectorPrefix && s.startsWith(selectorPrefix) ? s.slice(selectorPrefix.length) : s;

  for (const [_componentName, examples] of storybookExamples) {
    for (const example of examples) {
      const components = example.usedComponents;

      // Each component co-occurs with every other component in the same template
      for (const comp of components) {
        const normalized = stripPrefix(comp);
        if (!cooccurrences.has(normalized)) {
          cooccurrences.set(normalized, new Set());
        }
        const normalizedSet = cooccurrences.get(normalized)!;

        for (const other of components) {
          const otherNormalized = stripPrefix(other);
          if (otherNormalized !== normalized) {
            normalizedSet.add(otherNormalized);
          }
        }
      }
    }
  }

  // Convert sets to arrays
  const result = new Map<string, string[]>();
  for (const [key, value] of cooccurrences) {
    result.set(key, Array.from(value));
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function getComponentDirectories(componentsPath: string): string[] {
  if (!fs.existsSync(componentsPath)) return [];

  return fs
    .readdirSync(componentsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["src", "node_modules", ".git", "dist"].includes(entry.name))
    .map((entry) => entry.name);
}

function getTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(dir, f));
}

/**
 * Extract subpath-prefixed imports (e.g. `@angular/material/button`) from a TypeScript file.
 */
export function extractImportsFromFile(filePath: string, componentsPath: string, importPrefix = ""): string[] {
  const imports: string[] = [];
  const sourceCode = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ES2022, true);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const moduleSpecifier = statement.moduleSpecifier.text;

    // Match <importPrefix>{name} imports
    if (importPrefix && moduleSpecifier.startsWith(importPrefix)) {
      const componentName = moduleSpecifier.slice(importPrefix.length).split("/")[0];
      if (componentName && !imports.includes(componentName)) {
        imports.push(componentName);
      }
    }

    // Match relative imports that reference other component directories
    if (moduleSpecifier.startsWith("../") || moduleSpecifier.startsWith("./")) {
      const resolvedPath = path.resolve(path.dirname(filePath), moduleSpecifier);
      const relativeToCL = path.relative(componentsPath, resolvedPath);

      // If it goes to a sibling component directory
      if (!relativeToCL.startsWith("..") && relativeToCL.includes(path.sep)) {
        const componentName = relativeToCL.split(path.sep)[0];
        if (componentName && !imports.includes(componentName)) {
          imports.push(componentName);
        }
      }
    }
  }

  return imports;
}
