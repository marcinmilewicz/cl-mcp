/**
 * React Framework Analyzer
 *
 * `FrameworkAnalyzer` implementation for React component libraries. Produces
 * the same `ComponentMetadataFile` shape as the Angular pipeline (schema
 * v4.2, `framework: "react"`), so the MCP server serves both frameworks with
 * zero changes.
 *
 * Discovery is FLAT: every non-test `.ts`/`.tsx` file under the library path
 * is analyzed and each detected component becomes its own metadata entry,
 * keyed by its JSX name (`Button`). Directory-per-component grouping and
 * configurable layouts arrive with the workspace discovery layer (Phase 2).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DiagnosticsCollector } from "../../shared/diagnostics.js";
import {
  type ImportGraph,
  buildStorybookCooccurrences,
  findRelatedComponents,
  resolveDependencies,
} from "../../shared/import-graph.js";
import type {
  AnalyzedComponentEntry,
  AnalyzerOptions,
  ComponentAnalysis,
  ComponentMetadataFile,
  ContentSlotInfo,
  DeprecationInfo,
  FileAnalysis,
  FrameworkAnalyzer,
  ImportGraphEntry,
  Mutable,
  SelectorQuickInfo,
  StorybookExample,
} from "../../types.js";
import { asFilePath } from "../../types.js";
import { METADATA_SCHEMA_VERSION } from "../angular/angular-framework-analyzer.js";
import { ReactAstAnalyzer } from "./react-analyzer.js";
import { extractReactStories } from "./react-storybook-extractor.js";

const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", ".storybook", "coverage"]);
const TEST_FILE = /\.(spec|test)\.[jt]sx?$/;
const STORY_FILE = /\.stories\.[jt]sx?$/;

export class ReactFrameworkAnalyzer implements FrameworkAnalyzer {
  readonly framework = "react" as const;

  async analyze(libraryPath: string, options: AnalyzerOptions = {}): Promise<ComponentMetadataFile> {
    const packageName = options.packageName ?? path.basename(libraryPath);
    const importPrefix = options.importPrefix ?? `${packageName}/`;

    const diagnostics = new DiagnosticsCollector();
    const analyzer = new ReactAstAnalyzer();
    analyzer.setDiagnostics(diagnostics);

    // ── Discovery ───────────────────────────────────────────────────────
    const allFiles = collectFiles(libraryPath);
    const componentFiles = allFiles.filter(
      (f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !TEST_FILE.test(f) && !STORY_FILE.test(f),
    );
    const storyFiles = allFiles.filter((f) => STORY_FILE.test(f));
    if (options.storybookPath && fs.existsSync(options.storybookPath)) {
      storyFiles.push(...collectFiles(options.storybookPath).filter((f) => STORY_FILE.test(f)));
    }

    console.log(`Found ${componentFiles.length} source files (${storyFiles.length} story files)`);

    // ── ts.Program ──────────────────────────────────────────────────────
    console.log("Creating TypeScript program for type resolution...");
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
      skipLibCheck: true,
      strict: false,
      noEmit: true,
    };
    const program = ts.createProgram(componentFiles, compilerOptions);
    analyzer.setProgram(program);
    console.log(`TypeScript program created with ${componentFiles.length} files`);

    // ── Per-file analysis → per-component entries ───────────────────────
    interface DetectedComponent {
      name: string;
      filePath: string;
      fileAnalysis: FileAnalysis;
      component: ComponentAnalysis;
      slots: ContentSlotInfo[];
      deprecation?: DeprecationInfo;
    }
    const detected: DetectedComponent[] = [];
    const fileToComponents = new Map<string, string[]>();

    for (const filePath of componentFiles) {
      try {
        const result = analyzer.analyzeFile(filePath);
        for (const component of result.analysis.components) {
          if (detected.some((d) => d.name === component.className)) {
            diagnostics.push({
              severity: "warn",
              code: "duplicate-component-name",
              component: component.className,
              file: path.relative(libraryPath, filePath),
              message: `Component name '${component.className}' is defined in multiple files; keeping the first occurrence.`,
            });
            continue;
          }
          detected.push({
            name: component.className,
            filePath,
            fileAnalysis: result.analysis,
            component,
            slots: result.slots.get(component.className) ?? [],
            deprecation: result.deprecations.get(component.className),
          });
          const owners = fileToComponents.get(filePath) ?? [];
          owners.push(component.className);
          fileToComponents.set(filePath, owners);
        }
      } catch (err) {
        diagnostics.push({
          severity: "error",
          code: "component-analysis-failed",
          file: path.relative(libraryPath, filePath),
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
    console.log(`Detected ${detected.length} components`);

    // ── Import graph (file-level relative imports → owning components) ──
    const importGraph = buildReactImportGraph(detected, fileToComponents, libraryPath, importPrefix);

    // ── Storybook (CSF, best-effort) ────────────────────────────────────
    const storiesByComponent = new Map<string, StorybookExample[]>();
    const rawTagsByExample = new Map<StorybookExample, string[]>();
    for (const storyFile of storyFiles) {
      try {
        const source = fs.readFileSync(storyFile, "utf-8");
        const sf = ts.createSourceFile(storyFile, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
        const extraction = extractReactStories(sf);
        const owner = resolveStoryOwner(extraction.componentName, storyFile, detected);
        if (!owner) continue;
        const list = storiesByComponent.get(owner) ?? [];
        for (const example of extraction.examples) {
          (example as { filePath: string }).filePath = asFilePath(path.relative(libraryPath, storyFile));
          list.push(example);
          rawTagsByExample.set(example, extraction.rawJsxTags.get(example) ?? []);
        }
        storiesByComponent.set(owner, list);
      } catch (err) {
        diagnostics.push({
          severity: "warn",
          code: "storybook-failed",
          file: path.relative(libraryPath, storyFile),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Assemble entries ────────────────────────────────────────────────
    const metadata: ComponentMetadataFile = {
      version: METADATA_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      framework: this.framework,
      libraryName: packageName,
      componentsPath: `node_modules/${packageName}`,
      importPrefix,
      libraryDocumentation: readDocs(options.documentationPath),
      components: {},
      selectorMap: {},
    };

    for (const d of detected) {
      const relFile = path.relative(libraryPath, d.filePath);
      const narrowed: FileAnalysis = {
        ...d.fileAnalysis,
        filePath: asFilePath(relFile),
        components: [{ ...d.component, filePath: asFilePath(relFile) }],
      };
      const graphEntry = importGraph.entries.get(d.name);
      const entry: AnalyzedComponentEntry = {
        kind: "analyzed",
        name: d.name,
        exports: [d.name],
        files: [relFile],
        analysis: [narrowed],
        dependencies: resolveDependencies(d.name, importGraph),
        examples: [],
        contentProjection: d.slots,
        deprecation: d.deprecation,
        configTokens: [],
        storybookExamples: storiesByComponent.get(d.name) ?? [],
        importsFrom: graphEntry?.imports ?? [],
        relatedComponents: [],
        llmSummary: buildLlmSummary(d),
        commonPatterns: [],
        inheritanceResolved: true,
      };
      metadata.components[d.name] = entry;
    }

    // ── Selector map (JSX names; no prefix filtering for React) ─────────
    console.log("Generating selector map...");
    for (const d of detected) {
      const entry = metadata.components[d.name];
      if (entry.kind !== "analyzed" || !metadata.selectorMap) continue;
      metadata.selectorMap[d.name] = buildReactSelectorEntry(d.component, d.name, entry);
    }
    console.log(`Generated ${Object.keys(metadata.selectorMap ?? {}).length} selector mappings`);

    // ── Storybook usedComponents resolution + co-occurrence ─────────────
    const storybookExamplesMap = new Map<string, Array<{ usedComponents: string[] }>>();
    for (const [owner, examples] of storiesByComponent) {
      for (const example of examples) {
        const tags = rawTagsByExample.get(example) ?? [];
        const resolved = new Set<string>();
        const refs: { selector: string; kind: "element" | "attribute" }[] = [];
        for (const tag of tags) {
          if (metadata.selectorMap?.[tag]) {
            resolved.add(tag);
            refs.push({ selector: tag, kind: "element" });
          }
        }
        const mutable = example as unknown as {
          usedComponents: string[];
          usedComponentRefs?: { selector: string; kind: "element" | "attribute" }[];
        };
        mutable.usedComponents = [...resolved].sort();
        if (refs.length > 0) mutable.usedComponentRefs = refs;
      }
      storybookExamplesMap.set(
        owner,
        examples.map((ex) => ({ usedComponents: [...ex.usedComponents] })),
      );
    }

    console.log("Computing related components...");
    const cooccurrences = buildStorybookCooccurrences(storybookExamplesMap, "");
    for (const [componentName, entry] of Object.entries(metadata.components)) {
      if (entry.kind !== "analyzed") continue;
      entry.relatedComponents = findRelatedComponents(componentName, importGraph, cooccurrences);
    }

    const collected = diagnostics.all();
    if (collected.length > 0) {
      metadata.diagnostics = collected;
    }

    return metadata;
  }
}

// ============================================================================
// Discovery / helpers
// ============================================================================

function collectFiles(dir: string, visited: Set<string> = new Set()): string[] {
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return [];
  }
  if (visited.has(realDir)) return [];
  visited.add(realDir);

  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
      results.push(...collectFiles(fullPath, visited));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function readDocs(documentationPath: string | undefined): string | undefined {
  if (!documentationPath || !fs.existsSync(documentationPath)) return undefined;
  const content = fs.readFileSync(documentationPath, "utf-8");
  console.log(`Loaded library documentation (${content.length} chars)`);
  return content || undefined;
}

/**
 * Relative + importPrefix imports resolved to the components that own the
 * target file. Reuses the shared `ImportGraph` shape so
 * `findRelatedComponents` / `resolveDependencies` work as-is.
 */
function buildReactImportGraph(
  detected: ReadonlyArray<{ name: string; filePath: string }>,
  fileToComponents: ReadonlyMap<string, string[]>,
  libraryPath: string,
  importPrefix: string,
): ImportGraph {
  const graph: ImportGraph = { entries: new Map() };
  const byName = new Map(detected.map((d) => [d.name, d]));

  for (const d of detected) {
    const entry: Mutable<ImportGraphEntry> = { component: d.name, imports: [], importedBy: [] };
    const source = fs.readFileSync(d.filePath, "utf-8");
    const sf = ts.createSourceFile(d.filePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;

      let targetFile: string | null = null;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        targetFile = resolveRelativeModule(path.dirname(d.filePath), spec);
      } else if (importPrefix && spec.startsWith(importPrefix)) {
        // Subpath import naming another component: `<pkg>/Button`.
        const tail = spec.slice(importPrefix.length).split("/")[0];
        if (tail && byName.has(tail) && tail !== d.name && !entry.imports.includes(tail)) {
          entry.imports.push(tail);
        }
        continue;
      }
      if (!targetFile) continue;

      for (const owner of fileToComponents.get(targetFile) ?? []) {
        if (owner !== d.name && !entry.imports.includes(owner)) entry.imports.push(owner);
      }
    }
    graph.entries.set(d.name, entry);
  }

  for (const [name, entry] of graph.entries) {
    for (const imported of entry.imports) {
      const importedEntry = graph.entries.get(imported) as Mutable<ImportGraphEntry> | undefined;
      if (importedEntry && !importedEntry.importedBy.includes(name)) {
        importedEntry.importedBy.push(name);
      }
    }
  }

  void libraryPath;
  return graph;
}

function resolveRelativeModule(fromDir: string, spec: string): string | null {
  const base = path.resolve(fromDir, spec);
  const candidates = [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Story files attach to the component named in `meta.component`, else by filename. */
function resolveStoryOwner(
  metaComponent: string | undefined,
  storyFile: string,
  detected: ReadonlyArray<{ name: string }>,
): string | null {
  if (metaComponent && detected.some((d) => d.name === metaComponent)) return metaComponent;
  const base = path.basename(storyFile).replace(STORY_FILE, "").replace(/[-_.]/g, "").toLowerCase();
  const match = detected.find((d) => d.name.toLowerCase() === base);
  return match ? match.name : null;
}

function buildReactSelectorEntry(
  component: ComponentAnalysis,
  componentName: string,
  entry: AnalyzedComponentEntry,
): SelectorQuickInfo {
  const sortedInputs = [...component.inputs].sort((a, b) => {
    if (a.required && !b.required) return -1;
    if (!a.required && b.required) return 1;
    return a.name.localeCompare(b.name);
  });
  return {
    component: componentName,
    type: "component",
    mainInputs: sortedInputs.slice(0, 5).map((i) => (i.required ? `${i.name}*` : i.name)),
    mainOutputs: component.outputs.slice(0, 3).map((o) => o.name),
    hasContentSlots: (entry.contentProjection?.length ?? 0) > 0 || undefined,
    deprecated: entry.deprecation ? true : undefined,
  };
}

function buildLlmSummary(d: {
  name: string;
  component: ComponentAnalysis;
  slots: ContentSlotInfo[];
  deprecation?: DeprecationInfo;
}): string {
  const parts: string[] = [`<${d.name}>`];
  const inputs = d.component.inputs.length;
  const outputs = d.component.outputs.length;
  if (inputs > 0 || outputs > 0) {
    parts.push(`${inputs} props, ${outputs} callback${outputs === 1 ? "" : "s"}`);
  }
  if (d.slots.length > 0) {
    const named = d.slots.filter((s) => s.name !== "children");
    parts.push(named.length > 0 ? `content slots: ${d.slots.map((s) => s.name).join(", ")}` : "accepts children");
  }
  if (d.deprecation) parts.push("DEPRECATED");
  return `${parts.join(". ")}.`;
}
