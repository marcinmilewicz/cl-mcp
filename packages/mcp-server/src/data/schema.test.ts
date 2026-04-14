import { describe, it, expect } from 'vitest';
import { parseComponentMetadata, ComponentMetadataFileSchema } from './schema.js';

function validFile() {
  return {
    version: '4.0.0',
    generatedAt: '2026-04-13T00:00:00.000Z',
    componentsPath: 'node_modules/@example/lib',
    components: {
      button: {
        kind: 'analyzed',
        name: 'button',
        exports: ['ButtonComponent'],
        files: ['button.component.ts'],
        analysis: [
          {
            filePath: 'button/button.component.ts',
            components: [
              {
                className: 'ButtonComponent',
                filePath: 'button/button.component.ts',
                metadata: {
                  selector: 'ex-button',
                  standalone: true,
                  changeDetection: 'OnPush',
                },
                inputs: [],
                outputs: [],
                publicMethods: [],
                dependencies: [],
                lifecycleHooks: [],
                exportedTypes: [],
              },
            ],
            directives: [],
            pipes: [],
            services: [],
            exportedTypes: [],
            exportedFunctions: [],
          },
        ],
        dependencies: {
          required: [],
          optional: [],
          providers: { required: [], optional: [] },
        },
        examples: [],
        inheritanceResolved: true,
      },
    },
  };
}

describe('parseComponentMetadata', () => {
  it('parses a minimal valid metadata file cleanly', () => {
    const parsed = parseComponentMetadata(validFile());
    expect(parsed.version).toBe('4.0.0');
    expect(parsed.components.button.name).toBe('button');
  });

  it('throws descriptively when `version` is missing', () => {
    const bad = validFile() as Record<string, unknown>;
    delete bad.version;
    expect(() => parseComponentMetadata(bad)).toThrow(/version/);
  });

  it('throws when a component input `type` is a number instead of string|null', () => {
    const bad = validFile();
    (bad.components.button.analysis[0].components[0].inputs as unknown as unknown[]).push({
      name: 'foo',
      type: 42, // deliberate: schema requires string | null
      typeResolved: true,
      required: false,
      resolvedValues: null,
    });
    expect(() => parseComponentMetadata(bad)).toThrow(/type/);
  });

  it('rejects JSON that is not an object at the root', () => {
    expect(() => parseComponentMetadata('not an object')).toThrow();
    expect(() => parseComponentMetadata(null)).toThrow();
    expect(() => parseComponentMetadata(42)).toThrow();
  });

  it('accepts optional diagnostics array', () => {
    const doc = validFile() as Record<string, unknown> & { diagnostics?: unknown };
    doc.diagnostics = [{ severity: 'warn', code: 'x', message: 'y' }];
    expect(() => parseComponentMetadata(doc)).not.toThrow();
  });

  it('exported schema is usable directly via safeParse', () => {
    const res = ComponentMetadataFileSchema.safeParse(validFile());
    expect(res.success).toBe(true);
  });

  // ── Phase 7: discriminated-union invariants ──────────────────────

  it('rejects a component with BOTH template and templateUrl (XOR)', () => {
    const bad = validFile();
    (bad.components.button.analysis[0].components[0].metadata as Record<string, unknown>).template = '<div></div>';
    (bad.components.button.analysis[0].components[0].metadata as Record<string, unknown>).templateUrl = './foo.html';
    expect(() => parseComponentMetadata(bad)).toThrow(/template/);
  });

  it('accepts a component with just template', () => {
    const doc = validFile();
    (doc.components.button.analysis[0].components[0].metadata as Record<string, unknown>).template = '<div>ok</div>';
    expect(() => parseComponentMetadata(doc)).not.toThrow();
  });

  it('rejects an InputProperty with required:true AND defaultValue', () => {
    const bad = validFile();
    (bad.components.button.analysis[0].components[0].inputs as unknown as unknown[]).push({
      name: 'id',
      type: 'string',
      typeResolved: true,
      required: true,
      defaultValue: '"x"', // illegal: required inputs cannot carry a default
      resolvedValues: null,
    });
    expect(() => parseComponentMetadata(bad)).toThrow();
  });

  it('rejects an InjectedDependency with self:true AND skipSelf:true', () => {
    const bad = validFile();
    (bad.components.button.analysis[0].components[0].dependencies as unknown as unknown[]).push({
      name: 'svc',
      type: 'Svc',
      typeResolved: true,
      optional: false,
      host: false,
      self: true,
      skipSelf: true, // illegal per Angular DI
    });
    expect(() => parseComponentMetadata(bad)).toThrow(/skipSelf/);
  });

  it('round-trips a ValidationError-shaped payload through exported type discriminator', () => {
    // Sanity check: the exported schema still accepts enums on ExportedType['kind'].
    const doc = validFile();
    (doc.components.button.analysis[0].exportedTypes as unknown as unknown[]).push({
      kind: 'interface',
      name: 'Foo',
      definition: 'interface Foo {}',
      members: [],
    });
    expect(() => parseComponentMetadata(doc)).not.toThrow();
  });

  it('accepts `kind: "failed"` entries with only name + reason', () => {
    const doc = validFile() as Record<string, unknown> & {
      components: Record<string, unknown>;
    };
    doc.components.broken = { kind: 'failed', name: 'broken', reason: 'analyzer crash' };
    const parsed = parseComponentMetadata(doc);
    expect(parsed.components.broken.kind).toBe('failed');
  });

  it('does NOT require importedBy on disk; mcp-server computes it at load time', () => {
    // validFile has no importedBy — should parse cleanly.
    expect(() => parseComponentMetadata(validFile())).not.toThrow();
  });

  it('v4.1: preserves usedComponentRefs and ContentSlot.selectorAlternates (not stripped)', () => {
    const doc = validFile();
    const entry = doc.components.button as Record<string, unknown>;
    entry.contentProjection = [
      {
        name: 'default',
        selector: '[foo], [bar]',
        required: false,
        multiple: true,
        selectorAlternates: ['[foo]', '[bar]'],
      },
    ];
    entry.storybookExamples = [
      {
        storyName: 'Demo',
        filePath: 'button/button.stories.ts',
        template: '<ex-button>ok</ex-button>',
        args: {},
        usedComponents: ['button'],
        usedComponentRefs: [{ selector: 'mat-button', kind: 'attribute' }],
      },
    ];
    const parsed = parseComponentMetadata(doc);
    const parsedEntry = parsed.components.button as typeof parsed.components.button & {
      contentProjection?: Array<{ selectorAlternates?: string[] }>;
      storybookExamples?: Array<{ usedComponentRefs?: Array<{ selector: string; kind: string }> }>;
    };
    expect(parsedEntry.contentProjection?.[0].selectorAlternates).toEqual(['[foo]', '[bar]']);
    expect(parsedEntry.storybookExamples?.[0].usedComponentRefs).toEqual([
      { selector: 'mat-button', kind: 'attribute' },
    ]);
  });
});
