/**
 * Phase 7 tests for the load-time `importedBy` reverse index. The analyzer
 * only emits the forward `importsFrom` edge; the MCP server builds the
 * reverse index here to avoid referential-integrity drift on disk.
 */
import { describe, it, expect } from 'vitest';
import { buildImportedByIndex } from './metadata.js';
import type { ComponentMetadataFile } from '../types.js';

function mkAnalyzed(name: string, importsFrom: string[]): Record<string, unknown> {
  return {
    kind: 'analyzed',
    name,
    exports: [],
    files: [],
    analysis: [],
    dependencies: { required: [], optional: [], providers: { required: [], optional: [] } },
    examples: [],
    importsFrom,
    inheritanceResolved: true,
  };
}

describe('buildImportedByIndex', () => {
  it('builds a correct reverse index from forward importsFrom edges', () => {
    const file: unknown = {
      version: '4.0.0',
      generatedAt: 't',
      componentsPath: 'p',
      components: {
        button: mkAnalyzed('button', ['icon']),
        icon: mkAnalyzed('icon', []),
        card: mkAnalyzed('card', ['icon', 'button']),
      },
    };

    buildImportedByIndex(file as ComponentMetadataFile);

    const comps = (file as ComponentMetadataFile).components;
    // Both `card` and `button` import `icon`.
    const iconBy = comps.icon.kind === 'analyzed' ? comps.icon.importedBy ?? [] : [];
    expect([...iconBy].sort()).toEqual(['button', 'card']);

    // Only `card` imports `button`.
    const buttonBy = comps.button.kind === 'analyzed' ? comps.button.importedBy ?? [] : [];
    expect([...buttonBy]).toEqual(['card']);

    // `card` is not imported by anyone.
    const cardBy = comps.card.kind === 'analyzed' ? comps.card.importedBy ?? [] : [];
    expect([...cardBy]).toEqual([]);
  });

  it('clears any stray `importedBy` present on input before recomputing', () => {
    const file: unknown = {
      version: '4.0.0',
      generatedAt: 't',
      componentsPath: 'p',
      components: {
        a: { ...mkAnalyzed('a', ['b']), importedBy: ['stale'] },
        b: mkAnalyzed('b', []),
      },
    };

    buildImportedByIndex(file as ComponentMetadataFile);
    const comps = (file as ComponentMetadataFile).components;
    const aBy = comps.a.kind === 'analyzed' ? comps.a.importedBy ?? [] : [];
    expect(aBy).toEqual([]);
    const bBy = comps.b.kind === 'analyzed' ? comps.b.importedBy ?? [] : [];
    expect(bBy).toEqual(['a']);
  });

  it('skips non-analyzed entries on both ends of the edge', () => {
    const file: unknown = {
      version: '4.0.0',
      generatedAt: 't',
      componentsPath: 'p',
      components: {
        a: mkAnalyzed('a', ['broken']),
        broken: { kind: 'failed', name: 'broken', reason: 'oops' },
      },
    };

    buildImportedByIndex(file as ComponentMetadataFile);
    // `broken` is not analyzed — no importedBy to populate.
    expect((file as ComponentMetadataFile).components.broken.kind).toBe('failed');
  });
});
