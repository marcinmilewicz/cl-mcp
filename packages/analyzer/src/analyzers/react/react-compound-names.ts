/**
 * Compound (namespace) component naming — `Dialog.Root` instead of `DialogRoot`.
 *
 * Libraries like Base UI / Radix publish parts under a namespace:
 *
 *   // dialog/index.parts.ts
 *   export { DialogRoot as Root } from './root/DialogRoot';
 *   // dialog/index.ts
 *   export * as Dialog from './index.parts';
 *
 * Consumers write `<Dialog.Root>`, so that is the name the metadata should
 * lead with. This module statically resolves `export * as NS from '...'`
 * barrels and maps each detected component's INTERNAL name to its public
 * compound name (`DialogRoot` → `Dialog.Root`). Purely syntactic — no
 * TypeChecker required.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Resolve compound names for detected components.
 *
 * @param sourceFiles all non-test source files of the library
 * @param internalNames the detected components' internal (declaration) names
 * @returns map internal name → compound public name (only for components
 *          actually re-exported through a namespace barrel)
 */
export function resolveCompoundNames(
  sourceFiles: readonly string[],
  internalNames: ReadonlySet<string>,
): Map<string, string> {
  const compound = new Map<string, string>();

  for (const filePath of sourceFiles) {
    if (!filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) continue;
    const sf = parseFile(filePath);
    if (!sf) continue;

    for (const statement of sf.statements) {
      // export * as Dialog from './index.parts'
      if (
        !ts.isExportDeclaration(statement) ||
        !statement.exportClause ||
        !ts.isNamespaceExport(statement.exportClause) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const namespaceName = statement.exportClause.name.text;
      if (!/^[A-Z]/.test(namespaceName)) continue;

      const partsFile = resolveRelativeModule(path.dirname(filePath), statement.moduleSpecifier.text);
      if (!partsFile) continue;

      for (const [internal, publicPart] of namedReexportsOf(partsFile)) {
        if (!internalNames.has(internal)) continue;
        const name = `${namespaceName}.${publicPart}`;
        // First mapping wins — a component re-exported under several
        // namespaces keeps the first one deterministically (file order).
        if (!compound.has(internal)) compound.set(internal, name);
      }
    }
  }

  return compound;
}

/** `export { DialogRoot as Root, X } from '...'` → [ [DialogRoot, Root], [X, X] ]. */
function namedReexportsOf(filePath: string): Array<[internal: string, publicPart: string]> {
  const sf = parseFile(filePath);
  if (!sf) return [];
  const pairs: Array<[string, string]> = [];

  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const internal = (element.propertyName ?? element.name).text;
        pairs.push([internal, element.name.text]);
      }
    }
  }
  return pairs;
}

function parseFile(filePath: string): ts.SourceFile | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
}

function resolveRelativeModule(fromDir: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = path.resolve(fromDir, spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}
