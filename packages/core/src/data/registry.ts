/**
 * Library registry — multi-library support.
 *
 * Loads EVERY resolvable component-metadata.json (one per library) and keeps
 * them keyed by a short library name. The rest of the server still reads a
 * single "active" library through the existing accessors (`getMetadata()`,
 * `getLibraryConfig()`); tool handlers switch the active library before
 * delegating to domain code. Handlers compute synchronously, so the active
 * pointer cannot be observed mid-switch.
 *
 * A single metadata file (CL_MCP_METADATA_PATH or one data subdir) is the
 * single-library mode — behavior is identical to the pre-registry server.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LibraryConfig } from '../config.js';
import { setLibraryConfig } from '../config.js';
import type { ComponentMetadataFile } from '../types.js';
import { resolveAllMetadataPaths } from './paths.js';
import { parseComponentMetadata } from './schema.js';

export interface LoadedLibrary {
  /** Short name (e.g. `ui`) used as the qualifier in `ui:Button`. */
  name: string;
  metadataPath: string;
  metadata: ComponentMetadataFile;
  config: LibraryConfig;
}

let _libraries: Map<string, LoadedLibrary> | null = null;
let _activeName: string | null = null;

export function loadLibraries(): void {
  const metadataPaths = resolveAllMetadataPaths();
  const libraries = new Map<string, LoadedLibrary>();

  for (const metadataPath of metadataPaths) {
    const library = loadOne(metadataPath);
    let name = library.name;
    // Collision (two dirs deriving the same short name) — disambiguate.
    let suffix = 2;
    while (libraries.has(name)) {
      name = `${library.name}-${suffix++}`;
    }
    libraries.set(name, { ...library, name });
  }

  if (libraries.size === 0) {
    throw new Error('[MCP] No component metadata could be loaded.');
  }

  _libraries = libraries;
  _activeName = [...libraries.keys()][0];
  setLibraryConfig(libraries.get(_activeName)!.config);

  console.error(
    `[MCP] Loaded ${libraries.size} librar${libraries.size === 1 ? 'y' : 'ies'}: ` +
      [...libraries.values()].map((l) => `${l.name} (${l.config.framework ?? 'angular'}, v${l.metadata.version})`).join(', '),
  );
}

function loadOne(metadataPath: string): LoadedLibrary {
  const content = fs.readFileSync(metadataPath, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(
      `[cl-mcp] Could not parse ${metadataPath} as JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }

  let metadata: ComponentMetadataFile;
  try {
    metadata = parseComponentMetadata(raw);
  } catch (schemaErr) {
    const msg = schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
    console.error(msg);
    throw schemaErr;
  }

  buildImportedByIndex(metadata);

  const major = Number.parseInt(String(metadata.version).split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major !== 4) {
    console.error(
      `[cl-mcp] ${metadataPath}: schema v${metadata.version} but server expects v4.x; ` +
        `type fields may render as '<unresolved>' or carry legacy 'unknown'/'void' sentinels.`,
    );
  }
  if (metadata.diagnostics && metadata.diagnostics.length > 0) {
    const codes = metadata.diagnostics.map((d) => d.code);
    console.error(`[cl-mcp] ${metadataPath}: ${metadata.diagnostics.length} analyzer diagnostic(s): ${codes.join(', ')}`);
  }

  // Derive per-library config. v4.2+ files carry the canonical `libraryName`;
  // older files fall back to the componentsPath heuristic.
  const componentsPath = metadata.componentsPath || '';
  const packageName = metadata.libraryName || componentsPath.replace('node_modules/', '');
  let selectorPrefix = '';
  if (metadata.selectorMap) {
    const firstSelector = Object.keys(metadata.selectorMap)[0];
    const prefixMatch = firstSelector?.match(/^([a-z]+-)/);
    if (prefixMatch) selectorPrefix = prefixMatch[1];
  }

  const config: LibraryConfig = {
    name: packageName.split('/').pop() || 'unknown',
    selectorPrefix,
    packageName,
    version: metadata.version,
    framework: metadata.framework ?? 'angular',
  };

  // Short registry name: prefer the metadata's parent directory (matches the
  // workspace manifest naming), falling back to the package-name tail.
  const dirName = path.basename(path.dirname(metadataPath));
  const name = dirName && dirName !== '.' && dirName !== 'data' ? dirName : config.name;

  return { name, metadataPath, metadata, config };
}

// ── Access ──────────────────────────────────────────────────────────

function requireLibraries(): Map<string, LoadedLibrary> {
  if (!_libraries || !_activeName) {
    throw new Error('[MCP] Libraries not loaded. Call loadLibraries() first.');
  }
  return _libraries;
}

export function getLibraryNames(): string[] {
  return [...requireLibraries().keys()];
}

export function isMultiLibrary(): boolean {
  return requireLibraries().size > 1;
}

export function getActiveLibrary(): LoadedLibrary {
  const libraries = requireLibraries();
  return libraries.get(_activeName!)!;
}

export function setActiveLibrary(name: string): void {
  const libraries = requireLibraries();
  const library = libraries.get(name);
  if (!library) {
    throw new Error(`[MCP] Unknown library "${name}". Available: ${[...libraries.keys()].join(', ')}`);
  }
  _activeName = name;
  setLibraryConfig(library.config);
}

/** Run `fn` with the given library active, restoring the previous one after. */
export function withLibrary<T>(name: string, fn: () => T): T {
  const previous = _activeName;
  setActiveLibrary(name);
  try {
    return fn();
  } finally {
    if (previous) setActiveLibrary(previous);
  }
}

/**
 * Resolve a user-supplied library qualifier: exact registry name,
 * case-insensitive name, full import alias (`@acme/ui`), or alias tail.
 */
export function resolveLibraryQualifier(input: string): string | null {
  const libraries = requireLibraries();
  if (libraries.has(input)) return input;

  const lower = input.toLowerCase();
  for (const [name, lib] of libraries) {
    if (
      name.toLowerCase() === lower ||
      lib.config.packageName.toLowerCase() === lower ||
      lib.config.name.toLowerCase() === lower
    ) {
      return name;
    }
  }
  return null;
}

/** Test-only: reset registry state. */
export function __resetRegistryForTests(): void {
  _libraries = null;
  _activeName = null;
}

/** Test-only: inject libraries directly (bypasses path resolution). */
export function __setLibrariesForTests(libraries: Map<string, LoadedLibrary>): void {
  _libraries = libraries;
  _activeName = [...libraries.keys()][0] ?? null;
  if (_activeName) setLibraryConfig(libraries.get(_activeName)!.config);
}

// ── Derived indices ─────────────────────────────────────────────────

/**
 * Populate `importedBy` on every analyzed entry by reversing the
 * `importsFrom` edges. Exported (via metadata.ts) for tests.
 *
 * Referential-integrity note: the analyzer writes only the forward
 * `importsFrom` edge; keeping `importedBy` off disk means drift between
 * the two can't happen.
 */
export function buildImportedByIndex(file: ComponentMetadataFile): void {
  // Clear any stray field first (defensive against hand-edited JSON).
  for (const entry of Object.values(file.components)) {
    if (entry.kind === 'analyzed') {
      (entry as { importedBy?: readonly string[] }).importedBy = [];
    }
  }
  for (const [sourceName, entry] of Object.entries(file.components)) {
    if (entry.kind !== 'analyzed' || !entry.importsFrom) continue;
    for (const target of entry.importsFrom) {
      const targetEntry = file.components[target];
      if (!targetEntry || targetEntry.kind !== 'analyzed') continue;
      const list = targetEntry.importedBy as string[] | undefined;
      if (list && !list.includes(sourceName)) {
        list.push(sourceName);
      }
    }
  }
}
