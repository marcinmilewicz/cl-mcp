/**
 * Per-directory framework detection.
 *
 * Order of signals (strongest first):
 *   1. `package.json` dependencies: `@angular/core` → angular, `react` → react.
 *   2. Source scan: any `@Component(`/`@Directive(` decorator → angular;
 *      any `.tsx` file or JSX-looking `.ts`/`.jsx` content → react.
 *
 * Returns `null` when nothing matches — the caller decides whether that is
 * an error (explicit library entry) or a silent skip (scan candidate).
 */

import fs from "node:fs";
import path from "node:path";
import type { SupportedFramework } from "../types.js";

const MAX_SCAN_FILES = 50;

export function detectFramework(libraryPath: string): SupportedFramework | null {
  const fromPackageJson = detectFromPackageJson(libraryPath);
  if (fromPackageJson) return fromPackageJson;
  return detectFromSources(libraryPath);
}

function detectFromPackageJson(libraryPath: string): SupportedFramework | null {
  const pkgPath = path.join(libraryPath, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    if (deps["@angular/core"]) return "angular";
    if (deps.react) return "react";
  } catch {
    // Malformed package.json — fall through to source scan.
  }
  return null;
}

function detectFromSources(libraryPath: string): SupportedFramework | null {
  const files = collectSourceFiles(libraryPath, MAX_SCAN_FILES);
  let sawTsx = false;

  for (const file of files) {
    if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
      sawTsx = true;
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (/@(Component|Directive|Pipe|Injectable)\s*\(/.test(content)) return "angular";
    if (/from\s+["']react["']/.test(content)) sawTsx = true;
  }

  return sawTsx ? "react" : null;
}

function collectSourceFiles(dir: string, limit: number, results: string[] = []): string[] {
  if (results.length >= limit || !fs.existsSync(dir)) return results;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (results.length >= limit) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name)) {
      collectSourceFiles(fullPath, limit, results);
    } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}
