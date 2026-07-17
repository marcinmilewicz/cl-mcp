/**
 * Metadata Loader for @cl-mcp/mcp-server
 *
 * Loads and provides access to the pre-generated component-metadata.json.
 * Acts as the central data access layer.
 */

import type { AnalyzedComponentEntry, FileAnalysis, ComponentMetadataFile, ComponentMetadataEntry } from '../types.js';
import type { ComponentSearchMeta } from '../domain/search.js';
import { getActiveLibrary, loadLibraries } from './registry.js';

export type { ComponentMetadataEntry, ComponentMetadataFile } from '../types.js';
// Reverse-index builder lives in the registry now; re-exported for tests
// and back-compat.
export { buildImportedByIndex } from './registry.js';

// ── Metadata Access ─────────────────────────────────────────────────

/** Metadata of the ACTIVE library (see data/registry.ts for switching). */
export function getMetadata(): ComponentMetadataFile {
  try {
    return getActiveLibrary().metadata;
  } catch {
    throw new Error('[MCP] Metadata not loaded. Call loadPreloadedMetadata() first.');
  }
}

/**
 * Load every resolvable component-metadata.json into the registry.
 * Must be called once before any tool handlers access metadata.
 * A single file = single-library mode (pre-registry behavior).
 */
export function loadPreloadedMetadata(): void {
  try {
    loadLibraries();
  } catch (error) {
    throw new Error(`[MCP] Failed to load component metadata: ${error}`);
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
