/**
 * Metadata Loader for @cl-mcp/mcp-server
 *
 * Loads and provides access to the pre-generated component-metadata.json.
 * Acts as the central data access layer.
 */

import fs from 'node:fs';
import type { AnalyzedComponentEntry, FileAnalysis, ComponentMetadataFile, ComponentMetadataEntry } from '../types.js';
import type { ComponentSearchMeta } from '../domain/search.js';
import { METADATA_PATH } from './paths.js';
import { setLibraryConfig } from '../config.js';
import { parseComponentMetadata } from './schema.js';

export type { ComponentMetadataEntry, ComponentMetadataFile } from '../types.js';
export { METADATA_PATH } from './paths.js';

// ── State ───────────────────────────────────────────────────────────

let _metadata: ComponentMetadataFile | null = null;

// ── Metadata Access ─────────────────────────────────────────────────

export function getMetadata(): ComponentMetadataFile {
  if (!_metadata) {
    throw new Error('[MCP] Metadata not loaded. Call loadPreloadedMetadata() first.');
  }
  return _metadata;
}

/**
 * Load pre-generated metadata from component-metadata.json.
 * Must be called once before any tool handlers access metadata.
 */
export function loadPreloadedMetadata(): void {
  if (!fs.existsSync(METADATA_PATH)) {
    throw new Error(
      `[MCP] Component metadata not found at ${METADATA_PATH}. ` +
      `Set CL_MCP_METADATA_PATH to the correct path.`
    );
  }

  try {
    const content = fs.readFileSync(METADATA_PATH, 'utf-8');
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (parseErr) {
      throw new Error(`[cl-mcp] Could not parse ${METADATA_PATH} as JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    }
    try {
      _metadata = parseComponentMetadata(raw);
      // v4.0 Phase 7: `importedBy` is NOT on disk — build the reverse index
      // from every analyzed entry's `importsFrom`. Mutates entries in place.
      buildImportedByIndex(_metadata);
    } catch (schemaErr) {
      // Trust-boundary failure: log the Zod issues to stderr and re-throw so
      // the server fails loudly. Silent degradation would let drift rot for
      // months before anyone noticed.
      const msg = schemaErr instanceof Error ? schemaErr.message : String(schemaErr);
      console.error(msg);
      throw schemaErr;
    }
    console.error(
      `[MCP] Loaded metadata v${_metadata.version} ` +
      `(${Object.keys(_metadata.components).length} components) ` +
      `from ${METADATA_PATH}`
    );

    // Schema-version compatibility check (v4.0 sentinel changes are breaking).
    // Don't refuse to load — surface a clear warning so older metadata is at
    // least obvious in the logs.
    const major = Number.parseInt(String(_metadata.version).split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major !== 4) {
      console.error(
        `[cl-mcp] Loaded metadata schema v${_metadata.version} but server expects v4.x; ` +
        `type fields may render as '<unresolved>' or carry legacy 'unknown'/'void' sentinels.`,
      );
    }

    if (_metadata.diagnostics && _metadata.diagnostics.length > 0) {
      const codes = _metadata.diagnostics.map((d) => d.code);
      console.error(`[cl-mcp] ${_metadata.diagnostics.length} analyzer diagnostic(s): ${codes.join(', ')}`);
    }

    // Derive library config from metadata. v4.2+ files carry the canonical
    // `libraryName`; older files fall back to the componentsPath heuristic.
    const componentsPath = _metadata.componentsPath || '';
    const packageName = _metadata.libraryName || componentsPath.replace('node_modules/', '');
    // Try to detect selector prefix from first component selector
    let selectorPrefix = '';
    if (_metadata.selectorMap) {
      const firstSelector = Object.keys(_metadata.selectorMap)[0];
      if (firstSelector) {
        const prefixMatch = firstSelector.match(/^([a-z]+-)/);
        if (prefixMatch) {
          selectorPrefix = prefixMatch[1];
        }
      }
    }

    setLibraryConfig({
      name: packageName.split('/').pop() || 'unknown',
      selectorPrefix,
      packageName,
      version: _metadata.version,
      framework: _metadata.framework ?? 'angular',
    });
  } catch (error) {
    throw new Error(`[MCP] Failed to load component metadata: ${error}`);
  }
}

// ── Derived indices ─────────────────────────────────────────────────

/**
 * Populate `importedBy` on every analyzed entry by reversing the
 * `importsFrom` edges. Exported for tests.
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

// ── Data Access Helpers ─────────────────────────────────────────────

export function getAvailableComponents(): string[] {
  return Object.keys(getMetadata().components);
}

export function getPreloadedComponentMetadata(componentName: string): ComponentMetadataEntry | null {
  return getMetadata().components[componentName] ?? null;
}

/**
 * Narrow a `ComponentMetadataEntry | null` (or a component name) down to
 * `AnalyzedComponentEntry | null`. Centralizes the `kind === 'analyzed'`
 * guard that was duplicated across formatters/search/resolver/context.
 */
export function getAnalyzedEntry(
  entryOrName: ComponentMetadataEntry | string | null | undefined,
): AnalyzedComponentEntry | null {
  const entry =
    typeof entryOrName === 'string' ? getPreloadedComponentMetadata(entryOrName) : entryOrName ?? null;
  return entry && entry.kind === 'analyzed' ? entry : null;
}

export function componentExists(componentName: string): boolean {
  return componentName in getMetadata().components;
}

export function getComponentAnalysis(componentName: string): readonly FileAnalysis[] {
  const preloaded = getPreloadedComponentMetadata(componentName);
  if (!preloaded || preloaded.kind !== 'analyzed') return [];
  return preloaded.analysis;
}

// ── Selector extraction helpers ─────────────────────────────────────

export function extractSelectors(preloaded: ComponentMetadataEntry | null): string[] {
  if (!preloaded || preloaded.kind !== 'analyzed') return [];
  return preloaded.analysis
    .flatMap((a) => a.components)
    .map((c) => c.metadata.selector)
    .filter((s) => Boolean(s)) as string[];
}

export function extractDirectiveSelectors(preloaded: ComponentMetadataEntry | null): string[] {
  if (!preloaded || preloaded.kind !== 'analyzed') return [];
  return preloaded.analysis
    .flatMap((a) => a.directives ?? [])
    .map((d) => d.metadata.selector)
    .filter((s) => Boolean(s)) as string[];
}

export function countDirectivesAndPipes(preloaded: ComponentMetadataEntry | null): { directives: number; pipes: number } {
  if (!preloaded || preloaded.kind !== 'analyzed') return { directives: 0, pipes: 0 };
  const directives = preloaded.analysis.reduce((sum, a) => sum + (a.directives?.length ?? 0), 0);
  const pipes = preloaded.analysis.reduce((sum, a) => sum + (a.pipes?.length ?? 0), 0);
  return { directives, pipes };
}

export function buildSearchMetadataMap(components: string[]): Map<string, ComponentSearchMeta> {
  const metadataMap = new Map<string, ComponentSearchMeta>();
  for (const compName of components) {
    const preloaded = getPreloadedComponentMetadata(compName);
    if (preloaded && preloaded.kind === 'analyzed') {
      const componentSelectors = extractSelectors(preloaded);
      const directiveSelectors = extractDirectiveSelectors(preloaded);
      metadataMap.set(compName, {
        llmSummary: preloaded.llmSummary,
        selectors: [...componentSelectors, ...directiveSelectors],
      });
    }
  }
  return metadataMap;
}
