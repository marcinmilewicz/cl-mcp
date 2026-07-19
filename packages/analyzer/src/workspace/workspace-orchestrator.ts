/**
 * Workspace orchestrator — runs the right `FrameworkAnalyzer` per resolved
 * library, writes one `component-metadata.json` per library plus a
 * `workspace-manifest.json` describing the whole run (libraries + the
 * cross-library import graph).
 *
 * Cross-library edges come from two signals, no workspace tool required:
 *   1. an import specifier matching another library's `importAlias`
 *   2. a relative import that resolves into another library's directory
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { AngularFrameworkAnalyzer, METADATA_SCHEMA_VERSION } from "../analyzers/angular/angular-framework-analyzer.js";
import { ReactFrameworkAnalyzer } from "../analyzers/react/react-framework-analyzer.js";
import { DiagnosticsCollector } from "../shared/diagnostics.js";
import type { AnalyzerDiagnostic, ComponentMetadataFile, FrameworkAnalyzer, WorkspaceManifest } from "../types.js";
import type { WorkspaceConfig } from "./config.js";
import type { ResolvedLibrary } from "./library-discovery.js";
import { resolveLibraries } from "./library-discovery.js";

export interface WorkspaceAnalysisResult {
  manifest: WorkspaceManifest;
  manifestPath: string;
  /** Per-library metadata (also written to disk). */
  libraries: Map<string, ComponentMetadataFile>;
  diagnostics: readonly AnalyzerDiagnostic[];
}

const ANALYZERS: Record<string, () => FrameworkAnalyzer> = {
  angular: () => new AngularFrameworkAnalyzer(),
  react: () => new ReactFrameworkAnalyzer(),
};

export async function analyzeWorkspace(
  config: WorkspaceConfig,
  rootDir: string,
  outputDirOverride?: string,
): Promise<WorkspaceAnalysisResult> {
  const diagnostics = new DiagnosticsCollector();
  const libraries = resolveLibraries(config, rootDir, diagnostics);
  if (libraries.length === 0) {
    throw new Error("[cl-mcp] No libraries resolved from the workspace config — nothing to analyze.");
  }

  const outputDir = path.resolve(rootDir, outputDirOverride ?? config.outputDir ?? "./data");
  fs.mkdirSync(outputDir, { recursive: true });

  const results = new Map<string, ComponentMetadataFile>();
  const manifestLibraries: WorkspaceManifest["libraries"][number][] = [];

  for (const lib of libraries) {
    console.log(`\n=== Analyzing library '${lib.name}' (${lib.framework}) at ${lib.path} ===`);
    const analyzer = ANALYZERS[lib.framework]?.();
    if (!analyzer) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-framework",
        message: `Library '${lib.name}': unsupported framework '${lib.framework}'.`,
      });
      continue;
    }

    if (lib.componentLayout !== "auto") {
      const native = lib.framework === "angular" ? "directory-per-component" : "flat";
      if (lib.componentLayout !== native) {
        diagnostics.push({
          severity: "warn",
          code: "component-layout-unsupported",
          message: `Library '${lib.name}': componentLayout '${lib.componentLayout}' is not implemented for ${lib.framework} (native: '${native}'); proceeding with the native layout.`,
        });
      }
    }

    try {
      const metadata = await analyzer.analyze(lib.path, {
        packageName: lib.importAlias,
        selectorPrefix: lib.selectorPrefix,
        importPrefix: `${lib.importAlias}/`,
        storybookPath: lib.storybookPath,
        documentationPath: lib.docsPath,
      });

      const libOutputDir = path.join(outputDir, lib.name);
      fs.mkdirSync(libOutputDir, { recursive: true });
      const metadataPath = path.join(libOutputDir, "component-metadata.json");
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      console.log(`Wrote ${path.relative(rootDir, metadataPath)}`);

      results.set(lib.name, metadata);
      manifestLibraries.push({
        name: lib.name,
        framework: lib.framework,
        path: path.relative(rootDir, lib.path),
        importAlias: lib.importAlias,
        metadataPath: path.relative(outputDir, metadataPath),
      });
    } catch (err) {
      diagnostics.push({
        severity: "error",
        code: "library-analysis-failed",
        message: `Library '${lib.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  const crossLibraryGraph = buildCrossLibraryGraph(
    libraries.filter((l) => results.has(l.name)),
    rootDir,
  );

  const manifest: WorkspaceManifest = {
    version: METADATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    libraries: manifestLibraries,
    crossLibraryGraph,
    diagnostics: diagnostics.all().length > 0 ? diagnostics.all() : undefined,
  };

  const manifestPath = path.join(outputDir, "workspace-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${path.relative(rootDir, manifestPath)}`);

  return { manifest, manifestPath, libraries: results, diagnostics: diagnostics.all() };
}

// ============================================================================
// Cross-library graph
// ============================================================================

export function buildCrossLibraryGraph(
  libraries: readonly ResolvedLibrary[],
  rootDir: string,
): Record<string, string[]> {
  void rootDir;
  const graph: Record<string, string[]> = {};

  for (const lib of libraries) {
    const edges = new Set<string>();
    for (const file of collectTsFiles(lib.path)) {
      for (const spec of importSpecifiersOf(file)) {
        const target = resolveImportToLibrary(spec, file, lib, libraries);
        if (target && target !== lib.name) edges.add(target);
      }
    }
    graph[lib.name] = [...edges].sort();
  }

  return graph;
}

function resolveImportToLibrary(
  spec: string,
  fromFile: string,
  fromLib: ResolvedLibrary,
  libraries: readonly ResolvedLibrary[],
): string | null {
  // Signal 1: alias match (longest alias wins so `@org/ui-icons` beats `@org/ui`).
  let best: ResolvedLibrary | null = null;
  for (const lib of libraries) {
    if (spec === lib.importAlias || spec.startsWith(`${lib.importAlias}/`)) {
      if (!best || lib.importAlias.length > best.importAlias.length) best = lib;
    }
  }
  if (best) return best.name;

  // Signal 2: relative import escaping into another library's directory.
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const resolved = path.resolve(path.dirname(fromFile), spec);
    for (const lib of libraries) {
      if (lib.path === fromLib.path) continue;
      const rel = path.relative(lib.path, resolved);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return lib.name;
    }
  }

  return null;
}

function collectTsFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name)) {
      collectTsFiles(fullPath, results);
    } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

function importSpecifiersOf(filePath: string): string[] {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, false, scriptKind);
  const specs: string[] = [];
  for (const statement of sf.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specs.push(statement.moduleSpecifier.text);
    }
  }
  return specs;
}
