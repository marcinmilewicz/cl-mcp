/**
 * Library discovery — resolves the workspace config (explicit `libraries`
 * entries + `scan` directories) into a concrete list of libraries to analyze.
 *
 * Deliberately NOT coupled to any workspace tool. Optional context is read
 * when present, never required:
 *   - `tsconfig.base.json` / `tsconfig.json` `compilerOptions.paths` →
 *     import aliases (works for NX and plain monorepos alike)
 *   - a library's own `package.json` `name` → import alias fallback
 *   - plain directories with neither → relative-path alias
 */

import fs from "node:fs";
import path from "node:path";
import type { DiagnosticsCollector } from "../shared/diagnostics.js";
import type { SupportedFramework } from "../types.js";
import type { ComponentLayout, LibraryEntry, WorkspaceConfig } from "./config.js";
import { detectFramework } from "./framework-detector.js";

export interface ResolvedLibrary {
  /** Short name used for the output directory and MCP identification. */
  name: string;
  /** Absolute path to the library root. */
  path: string;
  framework: SupportedFramework;
  /** Import specifier consumers use (e.g. `@myorg/ui`). */
  importAlias: string;
  selectorPrefix: string;
  componentLayout: ComponentLayout;
  storybookPath?: string;
  docsPath?: string;
}

export function resolveLibraries(
  config: WorkspaceConfig,
  rootDir: string,
  diagnostics: DiagnosticsCollector,
): ResolvedLibrary[] {
  const aliasMap = readTsconfigPathAliases(rootDir);
  const resolved: ResolvedLibrary[] = [];
  const seenPaths = new Set<string>();

  // 1. Explicit entries always win.
  for (const entry of config.libraries ?? []) {
    const lib = resolveOne(entry, rootDir, aliasMap, config, diagnostics, /* explicit */ true);
    if (lib) {
      resolved.push(lib);
      seenPaths.add(lib.path);
    }
  }

  // 2. Scan directories — each direct subdirectory is a candidate.
  for (const scan of config.scan ?? []) {
    const scanDir = path.resolve(rootDir, scan.dir);
    if (!fs.existsSync(scanDir)) {
      diagnostics.push({
        severity: "warn",
        code: "scan-dir-missing",
        message: `Scan directory does not exist: ${scanDir}`,
      });
      continue;
    }
    for (const dirent of fs.readdirSync(scanDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (matchesAnyGlob(dirent.name, scan.exclude ?? [])) continue;
      const candidatePath = path.join(scanDir, dirent.name);
      if (seenPaths.has(candidatePath)) continue;

      const lib = resolveOne(
        { path: path.relative(rootDir, candidatePath) },
        rootDir,
        aliasMap,
        config,
        diagnostics,
        /* explicit */ false,
      );
      if (lib) {
        resolved.push(lib);
        seenPaths.add(lib.path);
      }
    }
  }

  return resolved;
}

function resolveOne(
  entry: LibraryEntry,
  rootDir: string,
  aliasMap: Map<string, string>,
  config: WorkspaceConfig,
  diagnostics: DiagnosticsCollector,
  explicit: boolean,
): ResolvedLibrary | null {
  const absPath = path.resolve(rootDir, entry.path);
  if (!fs.existsSync(absPath)) {
    diagnostics.push({
      severity: explicit ? "error" : "warn",
      code: "library-path-missing",
      message: `Library path does not exist: ${absPath}`,
    });
    return null;
  }

  const framework = entry.framework ?? detectFramework(absPath);
  if (!framework) {
    diagnostics.push({
      severity: explicit ? "error" : "warn",
      code: "library-skipped",
      message: `Could not detect a framework for ${absPath}${explicit ? " — set 'framework' explicitly." : " (scan candidate skipped)."}`,
    });
    return null;
  }

  const importAlias =
    entry.importAlias ?? findAliasForPath(absPath, aliasMap) ?? readPackageName(absPath) ?? entry.path;
  const name = entry.name ?? importAlias.split("/").pop() ?? path.basename(absPath);

  return {
    name,
    path: absPath,
    framework,
    importAlias,
    selectorPrefix: entry.prefix ?? config.defaults?.prefix ?? "",
    componentLayout: entry.componentLayout ?? config.defaults?.componentLayout ?? "auto",
    storybookPath: entry.storybook ? path.resolve(rootDir, entry.storybook) : undefined,
    docsPath: entry.docs ? path.resolve(rootDir, entry.docs) : undefined,
  };
}

// ============================================================================
// Optional workspace context
// ============================================================================

/** `compilerOptions.paths` from tsconfig.base.json (preferred) or tsconfig.json. */
export function readTsconfigPathAliases(rootDir: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const filename of ["tsconfig.base.json", "tsconfig.json"]) {
    const tsconfigPath = path.join(rootDir, filename);
    if (!fs.existsSync(tsconfigPath)) continue;
    try {
      // tsconfig allows comments/trailing commas — strip line comments crudely
      // but sufficiently for the paths block.
      const raw = fs.readFileSync(tsconfigPath, "utf-8").replace(/^\s*\/\/.*$/gm, "");
      const parsed = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } };
      const paths = parsed.compilerOptions?.paths ?? {};
      for (const [alias, targets] of Object.entries(paths)) {
        const target = targets[0];
        if (!target) continue;
        const cleanAlias = alias.replace(/\/\*$/, "");
        const cleanTarget = path.resolve(rootDir, target.replace(/\/\*$/, ""));
        if (!aliases.has(cleanAlias)) aliases.set(cleanAlias, cleanTarget);
      }
      break; // first existing tsconfig wins
    } catch {
      // Unparseable tsconfig — aliases stay empty; discovery still works.
    }
  }
  return aliases;
}

function findAliasForPath(libraryPath: string, aliasMap: Map<string, string>): string | null {
  for (const [alias, target] of aliasMap) {
    if (target === libraryPath || isInside(target, libraryPath)) return alias;
  }
  return null;
}

function readPackageName(libraryPath: string): string | null {
  const pkgPath = path.join(libraryPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

function isInside(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Minimal glob: `*` matches any run of characters; everything else literal. */
export function matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
    return regex.test(name);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
