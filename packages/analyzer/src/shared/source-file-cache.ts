/**
 * SourceFileCache — parse each TypeScript source file at most once per CLI run.
 *
 * Keyed on absolute path (callers normalize). Pre-populate from a `ts.Program`
 * via `set(...)` so program-resolved SourceFiles (which back the type checker)
 * are reused by free-function analyzers like `analyzeInheritance`,
 * `analyzeContentProjection`, `extractDeprecation`, and `resolveConfigToken`.
 *
 * Introduced in Phase 2 — replaces ad-hoc `ts.createSourceFile` calls scattered
 * across the analyzer module.
 */

import fs from "node:fs";
import ts from "typescript";

export class SourceFileCache {
  private cache = new Map<string, ts.SourceFile>();
  private compilerTarget: ts.ScriptTarget;

  constructor(compilerOptions: ts.CompilerOptions = {}) {
    this.compilerTarget = compilerOptions.target ?? ts.ScriptTarget.ES2022;
  }

  /**
   * Get a SourceFile, parsing from disk on cache miss.
   * Returns undefined if the file does not exist.
   */
  get(filePath: string): ts.SourceFile | undefined {
    const cached = this.cache.get(filePath);
    if (cached) return cached;
    if (!fs.existsSync(filePath)) return undefined;
    const sourceText = fs.readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, sourceText, this.compilerTarget, true, ts.ScriptKind.TS);
    this.cache.set(filePath, sf);
    return sf;
  }

  /** Pre-populate from an existing SourceFile (e.g. one already in a ts.Program). */
  set(filePath: string, sf: ts.SourceFile): void {
    this.cache.set(filePath, sf);
  }

  has(filePath: string): boolean {
    return this.cache.has(filePath);
  }
}
