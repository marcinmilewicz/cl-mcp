/**
 * Angular Framework Analyzer
 *
 * The `FrameworkAnalyzer` implementation for Angular. Owns the full analysis
 * pipeline that previously lived in the CLI's `main()`:
 *
 *   discovery → ts.Program → per-component analysis → selector map →
 *   storybook-token resolution → co-occurrence → related components
 *
 * The CLI (`src/cli/generate-metadata.ts`) is a thin dispatcher over this
 * class: it parses argv, calls `analyze()`, writes the JSON, and applies the
 * exit policy. `analyze()` itself never writes files and never exits the
 * process, so it can be driven programmatically (workspace orchestration,
 * tests).
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DiagnosticsCollector } from "../../shared/diagnostics.js";
import {
  type ImportGraph,
  buildImportGraph,
  buildStorybookCooccurrences,
  findRelatedComponents,
  resolveDependencies,
} from "../../shared/import-graph.js";
import { TemplateParseCache } from "../../shared/template-parser.js";
import type {
  AnalyzedComponentEntry,
  AnalyzerOptions,
  ComponentAnalysis,
  ComponentMetadataFile,
  FileAnalysis,
  FrameworkAnalyzer,
  SelectorQuickInfo,
  StorybookExample,
} from "../../types.js";
import { asFilePath } from "../../types.js";
import {
  AngularAstAnalyzer,
  type ConfigTokenAnalysis,
  type ContentSlotAnalysis,
  type InheritanceAnalysis,
  SourceFileCache,
  analyzeContentProjection,
  analyzeInheritance,
  extractDeprecation,
  extractWithConfigTokens,
  parseNgContentSlots,
  resolveConfigToken,
} from "./angular-analyzer.js";
import { type RawTemplateTokens, StorybookExtractor } from "./storybook-extractor.js";

/** Schema version emitted by this analyzer. v4.2 adds `framework` + `libraryName` (additive). */
export const METADATA_SCHEMA_VERSION = "4.2.0";

// ============================================================================
// Component Discovery
// ============================================================================

const VALID_COMPONENT_NAME = /^[\w-]+$/;

function getAvailableComponents(componentsPath: string): string[] {
  if (!fs.existsSync(componentsPath)) return [];
  const entries = fs.readdirSync(componentsPath, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        VALID_COMPONENT_NAME.test(entry.name) &&
        entry.isDirectory() &&
        !["src", "node_modules", "dist", ".git"].includes(entry.name),
    )
    .map((entry) => entry.name);
}

function getComponentExports(componentDir: string): string[] {
  const indexPath = path.join(componentDir, "index.ts");
  if (!fs.existsSync(indexPath)) return [];

  const content = fs.readFileSync(indexPath, "utf-8");
  const sourceFile = ts.createSourceFile(indexPath, content, ts.ScriptTarget.ES2022, true);
  const exports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          exports.push(el.name.getText(sourceFile));
        }
      } else if (!statement.exportClause && statement.moduleSpecifier) {
        const moduleSpec = (statement.moduleSpecifier as ts.StringLiteral).text;
        const fullPath = path.join(componentDir, `${moduleSpec}.ts`);
        if (fs.existsSync(fullPath)) {
          exports.push(...getExportedSymbolsFromFile(fullPath));
        }
      }
    }
  }

  return [...new Set(exports)];
}

function getExportedSymbolsFromFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true);
  const symbols: string[] = [];

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const hasExport = !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;

    if (ts.isClassDeclaration(statement) && statement.name) {
      symbols.push(statement.name.getText(sourceFile));
    } else if (ts.isInterfaceDeclaration(statement)) {
      symbols.push(statement.name.getText(sourceFile));
    } else if (ts.isTypeAliasDeclaration(statement)) {
      symbols.push(statement.name.getText(sourceFile));
    } else if (ts.isEnumDeclaration(statement)) {
      symbols.push(statement.name.getText(sourceFile));
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbols.push(statement.name.getText(sourceFile));
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push(decl.name.getText(sourceFile));
        }
      }
    }
  }

  return symbols;
}

// ============================================================================
// File collection
// ============================================================================

function collectFilesRecursively(dir: string, visited: Set<string> = new Set()): string[] {
  // Resolve to a real path to defend against symlink cycles. If the directory
  // (or anywhere up-chain) has already been visited, bail out.
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
    if (entry.isDirectory() && !["node_modules", ".git", "dist"].includes(entry.name)) {
      results.push(...collectFilesRecursively(fullPath, visited));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================================
// Component Analysis
// ============================================================================

function analyzeComponent(
  componentName: string,
  componentsPath: string,
  analyzer: AngularAstAnalyzer,
  storybookExtractor: StorybookExtractor | null,
  importGraph: ImportGraph,
  importPrefix: string,
  diagnostics: DiagnosticsCollector,
  sourceFileCache: SourceFileCache,
  templateParseCache: TemplateParseCache,
): AnalyzedComponentEntry {
  const componentDir = path.join(componentsPath, componentName);
  const allFilePaths = collectFilesRecursively(componentDir);
  const tsFilePaths = allFilePaths.filter((f) => f.endsWith(".ts") && !f.includes(".spec."));

  // 1. Standard AST analysis. Keep absolute filePaths inside `analysis` until
  //    we serialize the final ComponentMetadataFile (Phase 2: stop in-place
  //    abs->rel mutation so the analyzer's free functions can keep using these
  //    absolute paths without juggling re-absolutization).
  const analysis = tsFilePaths.map((filePath) => analyzer.analyzeFile(filePath));

  // 2. Inheritance analysis
  const inheritanceMap: Record<string, InheritanceAnalysis> = {};
  let inheritanceFailed = false;
  for (const a of analysis) {
    for (const comp of [...a.components, ...a.directives]) {
      try {
        const { analysis: inh, resolved } = analyzeInheritance(
          comp.filePath,
          comp.className,
          componentsPath,
          analyzer,
          importPrefix,
          sourceFileCache,
          diagnostics,
        );
        if (!resolved) inheritanceFailed = true;
        if (inh.baseClass) {
          if (inh.baseClassPath) {
            (inh as { baseClassPath?: string }).baseClassPath = asFilePath(
              path.relative(componentsPath, inh.baseClassPath),
            );
          }
          inheritanceMap[comp.className] = inh;
        }
      } catch (err) {
        inheritanceFailed = true;
        diagnostics.push({
          severity: "warn",
          code: "inheritance-failed",
          component: componentName,
          file: path.relative(componentsPath, comp.filePath),
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
  }

  // 3. Content projection analysis
  const contentProjection: ContentSlotAnalysis[] = [];
  const seenSlotNames = new Set<string>();
  for (const filePath of tsFilePaths) {
    try {
      const slots = analyzeContentProjection(filePath, sourceFileCache, templateParseCache, diagnostics);
      for (const slot of slots) {
        if (!seenSlotNames.has(slot.name)) {
          seenSlotNames.add(slot.name);
          contentProjection.push(slot);
        }
      }
    } catch (err) {
      diagnostics.push({
        severity: "warn",
        code: "content-projection-failed",
        component: componentName,
        file: path.relative(componentsPath, filePath),
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  const htmlFilePaths = allFilePaths.filter((f) => f.endsWith(".html"));
  for (const htmlPath of htmlFilePaths) {
    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
    const htmlSlots = parseNgContentSlots(htmlContent, seenSlotNames, {
      sourceUrl: htmlPath,
      cache: templateParseCache,
      diagnostics,
    });
    contentProjection.push(...htmlSlots);
  }

  // 4. Deprecation detection
  let deprecation: AnalyzedComponentEntry["deprecation"];
  for (const a of analysis) {
    for (const comp of [...a.components, ...a.directives]) {
      try {
        deprecation = extractDeprecation(comp.filePath, comp.className, sourceFileCache);
        if (deprecation) break;
      } catch (err) {
        diagnostics.push({
          severity: "warn",
          code: "deprecation-failed",
          component: componentName,
          file: path.relative(componentsPath, comp.filePath),
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
    if (deprecation) break;
  }

  // 5. Config token resolution
  const configTokens: ConfigTokenAnalysis[] = [];
  const tokenFilePaths = tsFilePaths.filter(
    (f) => f.includes("config.token") || f.includes(".token.") || f.includes("-config."),
  );
  for (const tokenFilePath of tokenFilePaths) {
    try {
      const tokens = resolveConfigToken(tokenFilePath, sourceFileCache);
      for (const token of tokens) {
        (token as { filePath: string }).filePath = asFilePath(path.relative(componentsPath, token.filePath));
      }
      configTokens.push(...tokens);
    } catch (err) {
      diagnostics.push({
        severity: "warn",
        code: "config-token-failed",
        component: componentName,
        file: path.relative(componentsPath, tokenFilePath),
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  // 5b. @WithConfig() decorated inputs (NG-ZORRO-style global config). These
  //     live in regular component files, not *-config.*/*.token.* files.
  for (const filePath of tsFilePaths) {
    try {
      const tokens = extractWithConfigTokens(filePath, sourceFileCache);
      for (const token of tokens) {
        (token as { filePath: string }).filePath = asFilePath(path.relative(componentsPath, token.filePath));
      }
      configTokens.push(...tokens);
    } catch (err) {
      diagnostics.push({
        severity: "warn",
        code: "config-token-failed",
        component: componentName,
        file: path.relative(componentsPath, filePath),
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  // Serialize-time abs->rel conversion. Mutates `analysis` in place at the
  // very end so all preceding enhancement steps can rely on absolute paths.
  for (const a of analysis) {
    const mutA = a as unknown as {
      filePath: string;
      components: Array<{ filePath: string }>;
      directives: Array<{ filePath: string }>;
    };
    mutA.filePath = asFilePath(path.relative(componentsPath, a.filePath));
    for (const c of mutA.components) {
      c.filePath = asFilePath(path.relative(componentsPath, c.filePath));
    }
    for (const d of mutA.directives) {
      d.filePath = asFilePath(path.relative(componentsPath, d.filePath));
    }
  }

  // 6. Storybook examples
  let storybookExamples: StorybookExample[] = [];
  if (storybookExtractor) {
    try {
      storybookExamples = storybookExtractor.extractStories(componentName);
    } catch (err) {
      diagnostics.push({
        severity: "warn",
        code: "storybook-failed",
        component: componentName,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  // 7. Import graph relationships
  const deps = resolveDependencies(componentName, importGraph);
  const graphEntry = importGraph.entries.get(componentName);

  // 8. README
  const readmePath = path.join(componentDir, "README.md");
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf-8") : undefined;

  // 9. LLM summary
  const inheritance = Object.keys(inheritanceMap).length > 0 ? inheritanceMap : undefined;
  const llmSummary = generateLLMSummary(analysis, inheritanceMap, contentProjection, configTokens);

  // 10. Common patterns
  const commonPatterns = extractCommonPatterns(analysis, configTokens);

  return {
    kind: "analyzed",
    name: componentName,
    exports: getComponentExports(componentDir),
    files: tsFilePaths.map((f) => path.relative(componentDir, f)),
    readme,
    analysis,
    dependencies: deps,
    examples: [],
    inheritance,
    contentProjection,
    deprecation,
    configTokens,
    storybookExamples,
    // `importedBy` is computed at load time in the mcp-server to avoid
    // reverse-index drift on disk (v4.0, Phase 7).
    importsFrom: graphEntry?.imports || [],
    relatedComponents: [],
    llmSummary,
    commonPatterns,
    inheritanceResolved: !inheritanceFailed,
  };
}

// ============================================================================
// LLM Summary Generation
// ============================================================================

function generateLLMSummary(
  analysis: FileAnalysis[],
  inheritanceMap: Record<string, InheritanceAnalysis>,
  contentSlots: ContentSlotAnalysis[],
  configTokens: ConfigTokenAnalysis[],
): string {
  const parts: string[] = [];

  for (const a of analysis) {
    for (const comp of a.components) {
      if (
        comp.metadata.selector &&
        !comp.metadata.selector.startsWith("test-") &&
        !comp.metadata.selector.startsWith("storybook-")
      ) {
        parts.push(`<${comp.metadata.selector}>`);
        break;
      }
    }
  }

  let totalInputs = 0;
  let totalOutputs = 0;
  for (const a of analysis) {
    for (const comp of [...a.components, ...a.directives]) {
      totalInputs += comp.inputs.length;
      totalOutputs += comp.outputs.length;
    }
  }
  for (const inh of Object.values(inheritanceMap)) {
    totalInputs += inh.inheritedInputs.length;
    totalOutputs += inh.inheritedOutputs.length;
  }

  let directiveCount = 0;
  let pipeCount = 0;
  for (const a of analysis) {
    directiveCount += a.directives.filter((d) => !!d.metadata.selector).length;
    pipeCount += a.pipes.length;
  }

  if (totalInputs > 0 || totalOutputs > 0) {
    let ioPart = `${totalInputs} inputs, ${totalOutputs} outputs`;
    if (directiveCount > 0) ioPart += `, ${directiveCount} directive${directiveCount > 1 ? "s" : ""}`;
    if (pipeCount > 0) ioPart += `, ${pipeCount} pipe${pipeCount > 1 ? "s" : ""}`;
    parts.push(ioPart);
  } else if (directiveCount > 0 || pipeCount > 0) {
    const countParts: string[] = [];
    if (directiveCount > 0) countParts.push(`${directiveCount} directive${directiveCount > 1 ? "s" : ""}`);
    if (pipeCount > 0) countParts.push(`${pipeCount} pipe${pipeCount > 1 ? "s" : ""}`);
    parts.push(countParts.join(", "));
  }

  for (const a of analysis) {
    for (const comp of a.components) {
      if (comp.inputs.some((i) => i.name === "formControl" || i.name === "formControlName")) {
        parts.push("FormControl support");
        break;
      }
    }
  }

  const baseClasses = Object.values(inheritanceMap)
    .map((inh) => inh.baseClass)
    .filter(Boolean);
  if (baseClasses.length > 0) parts.push(`extends ${baseClasses.join(", ")}`);

  if (contentSlots.length > 0) {
    const named = contentSlots.filter((s) => s.name !== "default");
    if (named.length > 0) {
      parts.push(`content slots: ${contentSlots.map((s) => s.name).join(", ")}`);
    } else {
      parts.push("accepts content projection");
    }
  }

  if (configTokens.length > 0) {
    const tokenLabels = configTokens.map((t) => (t.kind === "with-config" ? `@WithConfig('${t.configKey}')` : t.token));
    parts.push(`configurable via ${tokenLabels.join(", ")}`);
  }

  return `${parts.join(". ")}.`;
}

function extractCommonPatterns(analysis: FileAnalysis[], configTokens: ConfigTokenAnalysis[]): string[] {
  const patterns: string[] = [];

  for (const a of analysis) {
    for (const comp of a.components) {
      if (comp.inputs.some((i) => i.name === "formControl" || i.name === "formControlName")) {
        patterns.push("Use with [formControl] or formControlName for reactive forms");
      }
    }
  }

  for (const token of configTokens) {
    if (token.kind === "with-config") {
      patterns.push(
        `Global config: @WithConfig() inputs under key '${token.configKey}' (${token.properties.map((p) => p.name).join(", ")}) — unbound inputs fall back to provideNzConfig({ ${token.configKey}: { ... } })`,
      );
    } else {
      patterns.push(`Configure with ${token.token} InjectionToken (interface: ${token.interface})`);
    }
  }

  return [...new Set(patterns)];
}

// ============================================================================
// Selector Map Generation
// ============================================================================

/**
 * Build a `SelectorQuickInfo` entry for a component or directive. Unified to
 * eliminate the near-duplicate component/directive branches that lived here
 * pre-Phase 6; returns `null` when the entry should be filtered out of the
 * selector map (empty selector, test/storybook prefix, or prefix mismatch).
 */
export function buildSelectorEntry(
  kind: "component" | "directive",
  item: ComponentAnalysis,
  componentName: string,
  entry: AnalyzedComponentEntry,
  selectorPrefix: string,
): { selector: string; info: SelectorQuickInfo } | null {
  const rawSelectorRaw = item.metadata.selector;
  if (!rawSelectorRaw) return null;

  // For directives, strip [ ] to evaluate test-/storybook- and prefix filters.
  const filterSelector = kind === "directive" ? rawSelectorRaw.replace(/[\[\]]/g, "") : rawSelectorRaw;

  if (filterSelector.startsWith("test-") || filterSelector.startsWith("storybook-")) return null;
  if (selectorPrefix && !filterSelector.startsWith(selectorPrefix)) {
    // Accept if ANY bracketed attribute token begins with the prefix. This
    // handles Material-style compound selectors like `button[mat-button],
    // a[mat-button]` where the tag (`button`/`a`) doesn't carry the library
    // prefix but the attribute token does. Applied to both components (e.g.
    // MatButton is a `@Component` whose selector is purely attribute-based)
    // and directives (e.g. [matTooltip]). Without this, attribute-directive
    // co-occurrence edges (plan-2 Commit 5 KPI) are invisible to the
    // selector map.
    const bracketTokens = Array.from(rawSelectorRaw.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1].trim());
    const anyMatch = bracketTokens.some((tok) => tok.startsWith(selectorPrefix));
    if (!anyMatch) return null;
  }

  const inheritance = entry.inheritance?.[item.className];
  const inheritedInputs = inheritance?.inheritedInputs ?? [];
  const inheritedOutputs = inheritance?.inheritedOutputs ?? [];

  const allInputs = [...item.inputs, ...inheritedInputs];
  const sortedInputs = [...allInputs].sort((a, b) => {
    if (a.required && !b.required) return -1;
    if (!a.required && b.required) return 1;
    return a.name.localeCompare(b.name);
  });

  const mainInputs = sortedInputs.slice(0, 5).map((i) => {
    const bindingName = i.alias || i.name;
    return i.required ? `${bindingName}*` : bindingName;
  });
  const allOutputs = [...item.outputs, ...inheritedOutputs];
  const mainOutputs = allOutputs.slice(0, 3).map((o) => o.alias || o.name);

  if (kind === "component") {
    const formControl = allInputs.some(
      (i) => (i.alias || i.name) === "formControl" || (i.alias || i.name) === "formControlName",
    );
    return {
      selector: rawSelectorRaw,
      info: {
        component: componentName,
        type: "component",
        mainInputs,
        mainOutputs,
        formControl: formControl || undefined,
        hasContentSlots: (entry.contentProjection?.length ?? 0) > 0 || undefined,
        deprecated: entry.deprecation ? true : undefined,
        configRequired:
          entry.dependencies.providers.required.length > 0 ? entry.dependencies.providers.required : undefined,
      },
    };
  }

  return {
    selector: rawSelectorRaw,
    info: {
      component: componentName,
      type: "directive",
      mainInputs,
      mainOutputs,
    },
  };
}

export function generateSelectorMap(
  metadata: ComponentMetadataFile,
  selectorPrefix: string,
  diagnostics?: DiagnosticsCollector,
): void {
  metadata.selectorMap = {};
  let filteredCount = 0;
  const selectorOwners = new Map<string, string>();

  const recordDuplicate = (selector: string, component: string) => {
    const prevOwner = selectorOwners.get(selector);
    if (prevOwner !== undefined && prevOwner !== component) {
      diagnostics?.push({
        severity: "warn",
        code: "duplicate-selector",
        component,
        message: `Selector "${selector}" is defined by multiple components (previous: ${prevOwner}); overwriting existing entry.`,
      });
    }
    selectorOwners.set(selector, component);
  };

  for (const [componentName, entry] of Object.entries(metadata.components)) {
    if (entry.kind !== "analyzed") continue;
    for (const analysisItem of entry.analysis) {
      for (const comp of analysisItem.components) {
        const built = buildSelectorEntry("component", comp, componentName, entry, selectorPrefix);
        if (!built) {
          if (comp.metadata.selector) filteredCount++;
          continue;
        }
        recordDuplicate(built.selector, componentName);
        metadata.selectorMap[built.selector] = built.info;
      }

      for (const dir of analysisItem.directives) {
        const built = buildSelectorEntry("directive", dir, componentName, entry, selectorPrefix);
        if (!built) {
          if (dir.metadata.selector) filteredCount++;
          continue;
        }
        recordDuplicate(built.selector, componentName);
        metadata.selectorMap[built.selector] = built.info;
      }
    }
  }

  console.log(`Generated ${Object.keys(metadata.selectorMap).length} selector mappings (${filteredCount} filtered)`);
}

// ============================================================================
// Storybook token resolution pass
// ============================================================================

/**
 * Resolve raw template tokens captured during storybook extraction against the
 * generated selector map and populate both `StorybookExample.usedComponents`
 * and `StorybookExample.usedComponentRefs`.
 *
 * Input: per-example `{elements, attributes}` tokens captured by
 * `StorybookExtractor` while walking each storybook template AST.
 *
 * Output: `usedComponents` becomes the sorted deduped set of owning component
 * names; `usedComponentRefs` records the structured `{selector, kind}` entries
 * (element vs. attribute) for downstream formatters.
 */
export function resolveStorybookUsedComponents(
  examples: readonly StorybookExample[],
  selectorMap: ComponentMetadataFile["selectorMap"],
  rawTokensByExample: ReadonlyMap<StorybookExample, RawTemplateTokens>,
): void {
  if (!selectorMap) return;

  // Reverse-lookup indexes keyed by the tokens stories actually reference.
  // `elementIndex[tagName] = componentName` — direct tag → owner.
  // `attributeIndex[attrName] = componentName` — attribute-directive selectors
  //   like `[matTooltip]`, `button[mat-button]` contribute every bracketed
  //   token as a distinct lookup key. Plain-element selectors (no brackets)
  //   don't contribute attribute keys; compound element+attr selectors
  //   (`input[matInput]`) do.
  const elementIndex = new Map<string, string>();
  const attributeIndex = new Map<string, string>();

  for (const [rawSelector, info] of Object.entries(selectorMap)) {
    // Selector may be a comma-separated compound; each clause is a separate
    // matcher.
    const clauses = rawSelector.split(",").map((c) => c.trim());
    for (const clause of clauses) {
      const bracketTokens = Array.from(clause.matchAll(/\[([^\]]+)\]/g)).map((m) => m[1].trim());
      const tagPart = clause.replace(/\[[^\]]+\]/g, "").trim();

      // A plain tag (no brackets) means "matches this element name".
      if (tagPart && bracketTokens.length === 0) {
        if (!elementIndex.has(tagPart)) elementIndex.set(tagPart, info.component);
      }

      // Each bracket token makes the selector match an attribute presence.
      for (const tok of bracketTokens) {
        // Strip attribute-value selectors like `[type=button]` → `type`.
        const name = tok.split("=")[0].trim();
        if (name && !attributeIndex.has(name)) attributeIndex.set(name, info.component);
      }
    }
  }

  for (const example of examples) {
    const tokens = rawTokensByExample.get(example);
    if (!tokens) continue;

    const resolvedNames = new Set<string>();
    const refs: { selector: string; kind: "element" | "attribute" }[] = [];
    const seenRefs = new Set<string>();

    const pushRef = (selector: string, kind: "element" | "attribute") => {
      const key = `${kind}:${selector}`;
      if (seenRefs.has(key)) return;
      seenRefs.add(key);
      refs.push({ selector, kind });
    };

    for (const el of tokens.elements) {
      const owner = elementIndex.get(el);
      if (owner) {
        resolvedNames.add(owner);
        pushRef(el, "element");
      }
    }

    for (const attr of tokens.attributes) {
      const owner = attributeIndex.get(attr);
      if (owner) {
        resolvedNames.add(owner);
        pushRef(attr, "attribute");
      }
    }

    const mutable = example as unknown as {
      usedComponents: string[];
      usedComponentRefs?: { selector: string; kind: "element" | "attribute" }[];
    };
    mutable.usedComponents = Array.from(resolvedNames).sort();
    if (refs.length > 0) {
      mutable.usedComponentRefs = refs.sort((a, b) =>
        a.kind === b.kind ? a.selector.localeCompare(b.selector) : a.kind.localeCompare(b.kind),
      );
    }
  }
}

// ============================================================================
// Framework Analyzer
// ============================================================================

export class AngularFrameworkAnalyzer implements FrameworkAnalyzer {
  readonly framework = "angular" as const;

  async analyze(libraryPath: string, options: AnalyzerOptions = {}): Promise<ComponentMetadataFile> {
    const packageName = options.packageName ?? path.basename(libraryPath);
    const importPrefix = options.importPrefix ?? `${packageName}/`;
    const selectorPrefix = options.selectorPrefix ?? "";

    const diagnostics = new DiagnosticsCollector();
    const analyzer = new AngularAstAnalyzer();
    analyzer.setDiagnostics(diagnostics);
    const components = getAvailableComponents(libraryPath);

    console.log(`Found ${components.length} components`);

    // Create TypeScript program for type resolution
    console.log("Creating TypeScript program for type resolution...");
    const allComponentTsFiles: string[] = [];
    for (const comp of components) {
      const compDir = path.join(libraryPath, comp);
      allComponentTsFiles.push(
        ...collectFilesRecursively(compDir).filter((f) => f.endsWith(".ts") && !f.includes(".spec.")),
      );
    }
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: [],
      skipLibCheck: true,
      noEmit: true,
    };
    const program = ts.createProgram(allComponentTsFiles, compilerOptions);
    analyzer.setTypeChecker(program);
    console.log(`TypeScript program created with ${allComponentTsFiles.length} files`);

    // One SourceFileCache shared by every enhancement step. Pre-populate from the
    // ts.Program so analyzeInheritance / analyzeContentProjection / extractDeprecation
    // / resolveConfigToken all reuse already-parsed SourceFiles.
    const sourceFileCache = new SourceFileCache(compilerOptions);
    for (const sf of program.getSourceFiles()) {
      if (!sf.isDeclarationFile) {
        sourceFileCache.set(sf.fileName, sf);
      }
    }

    // Shared Angular template parse cache — ensures each template/url pair is
    // parsed at most once across the three template-consuming call-sites.
    const templateParseCache = new TemplateParseCache();

    // Read library documentation
    let libraryDocumentation = "";
    if (options.documentationPath && fs.existsSync(options.documentationPath)) {
      libraryDocumentation = fs.readFileSync(options.documentationPath, "utf-8");
      console.log(`Loaded library documentation (${libraryDocumentation.length} chars)`);
    }

    // Initialize Storybook extractor
    let storybookExtractor: StorybookExtractor | null = null;
    if (options.storybookPath && fs.existsSync(options.storybookPath)) {
      storybookExtractor = new StorybookExtractor(
        options.storybookPath,
        selectorPrefix,
        templateParseCache,
        diagnostics,
      );
      console.log("Storybook extractor initialized");
    }

    // Build import graph
    console.log("Building import graph...");
    const importGraph = buildImportGraph(libraryPath, importPrefix);

    const storybookExamplesMap = new Map<string, Array<{ usedComponents: string[] }>>();

    const metadata: ComponentMetadataFile = {
      version: METADATA_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      framework: this.framework,
      libraryName: packageName,
      componentsPath: `node_modules/${packageName}`,
      importPrefix,
      libraryDocumentation: libraryDocumentation || undefined,
      components: {},
      selectorMap: {},
    };

    for (const componentName of components) {
      process.stdout.write(`  Analyzing ${componentName}...`);
      try {
        const entry = analyzeComponent(
          componentName,
          libraryPath,
          analyzer,
          storybookExtractor,
          importGraph,
          importPrefix,
          diagnostics,
          sourceFileCache,
          templateParseCache,
        );
        metadata.components[componentName] = entry;
        // Note: storybookExamplesMap is populated AFTER the resolution pass below
        // so the cooccurrence builder sees attribute-directive-aware tokens.
        console.log(" done");
      } catch (error) {
        console.log(` error: ${error}`);
        const reason = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          severity: "error",
          code: "component-analysis-failed",
          component: componentName,
          message: reason,
          stack: error instanceof Error ? error.stack : undefined,
        });
        // v4.0 Phase 7: record the entry as `kind: 'failed'` so downstream
        // consumers can distinguish intentional skip from analyzer failure.
        metadata.components[componentName] = { kind: "failed", name: componentName, reason };
      }
    }

    // Phase ordering (Commit 4 of plan-2): selector map MUST be built before the
    // storybook-token resolution pass so attribute-directive selectors can be
    // resolved against it. Cooccurrence + related components run after.

    // 1. Generate selector map
    console.log("Generating selector map...");
    generateSelectorMap(metadata, selectorPrefix, diagnostics);

    // 2. Resolve storybook raw template tokens against the selector map.
    const rawTokensByExample = storybookExtractor?.rawTemplateTokens ?? new Map<StorybookExample, RawTemplateTokens>();
    for (const entry of Object.values(metadata.components)) {
      if (entry.kind !== "analyzed") continue;
      if (!entry.storybookExamples || entry.storybookExamples.length === 0) continue;
      resolveStorybookUsedComponents(entry.storybookExamples, metadata.selectorMap, rawTokensByExample);
    }

    // 2b. Rebuild storybookExamplesMap from the resolved `usedComponents` so the
    //     cooccurrence builder sees the attribute-directive-aware token set (not
    //     the per-component-loop snapshot that was captured before resolution).
    storybookExamplesMap.clear();
    for (const [componentName, entry] of Object.entries(metadata.components)) {
      if (entry.kind !== "analyzed") continue;
      if (!entry.storybookExamples || entry.storybookExamples.length === 0) continue;
      storybookExamplesMap.set(
        componentName,
        entry.storybookExamples.map((ex) => ({ usedComponents: [...ex.usedComponents] })),
      );
    }

    // 3. Compute related components
    console.log("Computing related components...");
    const storybookCooccurrences = buildStorybookCooccurrences(storybookExamplesMap, selectorPrefix);
    for (const [componentName, entry] of Object.entries(metadata.components)) {
      if (entry.kind !== "analyzed") continue;
      entry.relatedComponents = findRelatedComponents(componentName, importGraph, storybookCooccurrences);
    }

    // Attach diagnostics (omit field entirely when empty to keep v3.0 consumers happy)
    const collected = diagnostics.all();
    if (collected.length > 0) {
      metadata.diagnostics = collected;
    }

    return metadata;
  }
}
