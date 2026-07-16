#!/usr/bin/env node
/**
 * Universal Metadata Generator CLI
 *
 * Thin dispatcher over the framework analyzers. Parses argv, resolves the
 * requested `FrameworkAnalyzer` implementation, runs `analyze()`, writes the
 * resulting component-metadata.json, and applies the exit policy. All actual
 * analysis lives in the framework analyzer (currently only Angular:
 * `src/analyzers/angular/angular-framework-analyzer.ts`).
 *
 * Usage:
 *   cl-mcp-analyze --framework angular --path ./node_modules/@angular/material --package @angular/material
 *   cl-mcp-analyze --framework angular --path ./libs/components --prefix ui- --storybook ./libs/storybook
 */

import fs from "node:fs";
import path from "node:path";
import { AngularFrameworkAnalyzer } from "../analyzers/angular/angular-framework-analyzer.js";
import type { FrameworkAnalyzer } from "../types.js";

// Re-exported from the framework analyzer for backwards compatibility (tests
// and downstream consumers imported these from the CLI module pre-v4.2).
export {
  buildSelectorEntry,
  generateSelectorMap,
  resolveStorybookUsedComponents,
} from "../analyzers/angular/angular-framework-analyzer.js";

// ============================================================================
// Framework analyzer registry
// ============================================================================

const ANALYZER_FACTORIES: Record<string, () => FrameworkAnalyzer> = {
  angular: () => new AngularFrameworkAnalyzer(),
};

export const SUPPORTED_FRAMEWORKS = Object.keys(ANALYZER_FACTORIES);

// ============================================================================
// CLI argument parsing
// ============================================================================

export interface CliArgs {
  framework: string;
  libraryPath: string;
  packageName: string;
  selectorPrefix: string;
  importPrefix: string;
  storybookPath?: string;
  docsPath?: string;
  outputPath: string;
  allowPartial: boolean;
}

export type ParseArgsResult = { ok: true; value: CliArgs } | { ok: false; error: string };

export const USAGE_TEXT = [
  "Usage: cl-mcp-analyze --framework angular --path <library-path> [options]",
  "Options:",
  "  --framework    Framework to analyze (default: angular)",
  "  --path         Path to component library source",
  "  --package      Package name (default: derived from path)",
  "  --prefix       Selector prefix (default: empty)",
  '  --import-prefix  Subpath import prefix used to detect sibling components (default: "<package>/")',
  "  --storybook    Path to storybook directory",
  "  --docs         Path to library documentation file",
  "  --output       Output path (default: ./component-metadata.json)",
  "  --allow-partial  Exit 0 even if error-severity diagnostics are emitted",
].join("\n");

/**
 * Pure argv parser. Does NOT call process.exit or read process.argv.
 * Callers handle the error case (typically: print usage + exit 1).
 *
 * Boolean flags recognized (no value consumed): --allow-partial.
 * Value flags consume the next token verbatim — including one that begins
 * with "--" (current known-buggy behavior pinned by tests).
 */
export function parseArgs(argv: string[]): ParseArgsResult {
  const BOOLEAN_FLAGS = new Set(["allow-partial"]);
  const parsed: Record<string, string> = {};
  const flags: Set<string> = new Set();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.replace("--", "");
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key);
      continue;
    }
    // Bug L4: previous parser consumed the next token verbatim, even if it
    // was another flag. Require the value to be a non-flag token.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, error: `--${key} requires a value` };
    }
    parsed[key] = next;
    i++;
  }

  const libraryPath = parsed.path || parsed.libraryPath || "";
  if (!libraryPath) {
    return { ok: false, error: "--path is required" };
  }

  const packageName = parsed.package || path.basename(libraryPath);
  const importPrefix = parsed["import-prefix"] ?? parsed.importPrefix ?? `${packageName}/`;

  return {
    ok: true,
    value: {
      framework: parsed.framework || "angular",
      libraryPath: path.resolve(libraryPath),
      packageName,
      selectorPrefix: parsed.prefix || "",
      importPrefix,
      storybookPath: parsed.storybook ? path.resolve(parsed.storybook) : undefined,
      docsPath: parsed.docs ? path.resolve(parsed.docs) : undefined,
      outputPath: parsed.output ? path.resolve(parsed.output) : "./component-metadata.json",
      allowPartial: flags.has("allow-partial"),
    },
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const result = parseArgs(process.argv.slice(2));
  if (!result.ok) {
    console.error(result.error);
    console.error(USAGE_TEXT);
    process.exit(1);
  }
  const args = result.value;

  console.log("=== cl-mcp Metadata Generator ===");
  console.log(`Framework: ${args.framework}`);
  console.log(`Library path: ${args.libraryPath}`);
  console.log(`Package: ${args.packageName}`);
  if (args.selectorPrefix) console.log(`Selector prefix: ${args.selectorPrefix}`);
  console.log(`Import prefix: ${args.importPrefix}`);

  const analyzerFactory = ANALYZER_FACTORIES[args.framework];
  if (!analyzerFactory) {
    console.error(`Unsupported framework: ${args.framework}. Currently supported: ${SUPPORTED_FRAMEWORKS.join(", ")}`);
    process.exit(1);
  }

  const startTime = Date.now();
  const analyzer = analyzerFactory();
  const metadata = await analyzer.analyze(args.libraryPath, {
    packageName: args.packageName,
    selectorPrefix: args.selectorPrefix,
    importPrefix: args.importPrefix,
    storybookPath: args.storybookPath,
    documentationPath: args.docsPath,
  });

  // Write output
  const outputDir = path.dirname(args.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(args.outputPath, JSON.stringify(metadata, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fileSize = (fs.statSync(args.outputPath).size / 1024 / 1024).toFixed(2);
  const collected = metadata.diagnostics ?? [];

  console.log("\n=== Generation Complete ===");
  console.log(`Output: ${args.outputPath}`);
  console.log(`Components: ${Object.keys(metadata.components).length}`);
  console.log(`File size: ${fileSize} MB`);
  console.log(`Time: ${elapsed}s`);
  if (collected.length > 0) {
    const errorCount = collected.filter((d) => d.severity === "error").length;
    const warnCount = collected.length - errorCount;
    console.log(`Diagnostics: ${errorCount} error(s), ${warnCount} warning(s)`);
  }

  const hasErrors = collected.some((d) => d.severity === "error");
  if (hasErrors && !args.allowPartial) {
    console.error("Exiting with code 1 due to error-severity diagnostics (use --allow-partial to override).");
    process.exit(1);
  }
}

// Run main() only when invoked as a CLI script, not when imported by tests.
// Compares resolved script path to the invoked entry module via import.meta.url.
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const entryUrl = new URL(`file://${path.resolve(entry)}`).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    console.error("Fatal error during metadata generation:", error);
    process.exit(1);
  });
}
