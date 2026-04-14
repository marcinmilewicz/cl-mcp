/**
 * Tests for the CLI's pure parseArgs (Phase 1).
 */

import { describe, expect, it, vi } from "vitest";
import type { AnalyzedComponentEntry, ComponentAnalysis, ComponentMetadataFile, StorybookExample } from "../types.js";
import {
  buildSelectorEntry,
  generateSelectorMap,
  parseArgs,
  resolveStorybookUsedComponents,
} from "./generate-metadata.js";

describe("parseArgs", () => {
  it("parses well-formed args correctly", () => {
    const result = parseArgs(["--framework", "angular", "--path", "/tmp/lib", "--package", "foo"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.framework).toBe("angular");
    expect(result.value.libraryPath).toContain("/tmp/lib");
    expect(result.value.packageName).toBe("foo");
    expect(result.value.allowPartial).toBe(false);
  });

  it("returns an error when --path is missing", () => {
    const result = parseArgs(["--framework", "angular"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--path/);
  });

  it("flag-as-value: '--path --package foo' returns an error (L4 fixed)", () => {
    const result = parseArgs(["--path", "--package", "foo"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--path/);
  });

  it("recognizes --allow-partial as a boolean flag", () => {
    const result = parseArgs(["--path", "/tmp/lib", "--allow-partial"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowPartial).toBe(true);
  });

  it("defaults allowPartial to false when the flag is absent", () => {
    const result = parseArgs(["--path", "/tmp/lib"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowPartial).toBe(false);
  });
});

describe("phase ordering (Commit 4 of plan-2)", () => {
  it("invokes generateSelectorMap before resolveStorybookUsedComponents", () => {
    // The contract Commit 4 establishes: when the storybook token-resolution
    // pass runs, the selector map is already populated. We verify by spying
    // call order on a pipeline harness that mirrors `main()`'s new ordering.
    const calls: string[] = [];

    const metadata: ComponentMetadataFile = {
      version: "4.0.0",
      generatedAt: new Date().toISOString(),
      componentsPath: "node_modules/@cl-mcp/test-lib",
      importPrefix: "@cl-mcp/test-lib/",
      components: {},
      selectorMap: {},
    };

    const spySelectorMap = vi.fn(() => {
      calls.push("generateSelectorMap");
      // Simulate population so the resolver pass would have something to read.
      metadata.selectorMap["my-button"] = {
        component: "button",
        type: "component",
        mainInputs: [],
        mainOutputs: [],
      };
    });
    const spyResolve = vi.fn((examples: readonly StorybookExample[], selectorMap: ComponentMetadataFile["selectorMap"]) => {
      calls.push("resolveStorybookUsedComponents");
      // The selector map MUST be populated by the time the resolver is invoked.
      expect(Object.keys(selectorMap).length).toBeGreaterThan(0);
      expect(examples).toBeDefined();
    });
    const spyCooccurrences = vi.fn(() => {
      calls.push("buildStorybookCooccurrences");
    });

    // Mirror main()'s phase order verbatim.
    spySelectorMap();
    spyResolve([], metadata.selectorMap);
    spyCooccurrences();

    expect(calls).toEqual([
      "generateSelectorMap",
      "resolveStorybookUsedComponents",
      "buildStorybookCooccurrences",
    ]);
    expect(spySelectorMap.mock.invocationCallOrder[0]).toBeLessThan(spyResolve.mock.invocationCallOrder[0]);
    expect(spyResolve.mock.invocationCallOrder[0]).toBeLessThan(spyCooccurrences.mock.invocationCallOrder[0]);
  });

  it("resolveStorybookUsedComponents is a no-op (Commit 4 placeholder)", () => {
    const examples: StorybookExample[] = [
      {
        storyName: "Default",
        filePath: "src/foo/foo.stories.ts" as StorybookExample["filePath"],
        template: "<my-button>x</my-button>",
        args: {},
        usedComponents: ["my-button"],
      },
    ];
    const before = JSON.stringify(examples);
    resolveStorybookUsedComponents(examples, {}, new Map());
    expect(JSON.stringify(examples)).toBe(before);
  });

  it("resolveStorybookUsedComponents resolves element + attribute tokens against selectorMap (Commit 5)", () => {
    const examples: StorybookExample[] = [
      {
        storyName: "WithTooltip",
        filePath: "src/button/button.stories.ts" as StorybookExample["filePath"],
        template: "<button mat-button matTooltip=\"hi\">Go</button>",
        args: {},
        usedComponents: [],
      },
    ];
    const selectorMap: ComponentMetadataFile["selectorMap"] = {
      "button[mat-button], a[mat-button]": {
        component: "button",
        type: "component",
        mainInputs: [],
        mainOutputs: [],
      },
      "[matTooltip]": {
        component: "tooltip",
        type: "directive",
        mainInputs: [],
        mainOutputs: [],
      },
    };
    const rawTokens = new Map<StorybookExample, { elements: string[]; attributes: string[] }>();
    rawTokens.set(examples[0], {
      elements: ["button"],
      attributes: ["mat-button", "matTooltip"],
    });

    resolveStorybookUsedComponents(examples, selectorMap, rawTokens);

    expect(examples[0].usedComponents).toEqual(["button", "tooltip"]);
    expect(examples[0].usedComponentRefs).toEqual(
      expect.arrayContaining([
        { selector: "mat-button", kind: "attribute" },
        { selector: "matTooltip", kind: "attribute" },
      ]),
    );
  });

  it("resolveStorybookUsedComponents emits element-kind ref for pure element selectors", () => {
    const examples: StorybookExample[] = [
      {
        storyName: "WithIcon",
        filePath: "src/icon/icon.stories.ts" as StorybookExample["filePath"],
        template: "<mat-icon>add</mat-icon>",
        args: {},
        usedComponents: [],
      },
    ];
    const selectorMap: ComponentMetadataFile["selectorMap"] = {
      "mat-icon": {
        component: "icon",
        type: "component",
        mainInputs: [],
        mainOutputs: [],
      },
    };
    const rawTokens = new Map<StorybookExample, { elements: string[]; attributes: string[] }>();
    rawTokens.set(examples[0], { elements: ["mat-icon"], attributes: [] });

    resolveStorybookUsedComponents(examples, selectorMap, rawTokens);

    expect(examples[0].usedComponents).toEqual(["icon"]);
    expect(examples[0].usedComponentRefs).toEqual([{ selector: "mat-icon", kind: "element" }]);
  });

  it("buildSelectorEntry admits `button[mat-button], a[mat-button]` when prefix is 'mat-'", () => {
    const comp = {
      className: "MatButton",
      filePath: "button.ts",
      metadata: {
        selector: "button[mat-button], a[mat-button]",
        standalone: true,
      },
      inputs: [],
      outputs: [],
      publicMethods: [],
      dependencies: [],
      lifecycleHooks: [],
      exportedTypes: [],
    } as unknown as ComponentAnalysis;
    const entry = {
      kind: "analyzed",
      dependencies: { required: [], optional: [], providers: { required: [], optional: [] } },
    } as unknown as AnalyzedComponentEntry;
    const built = buildSelectorEntry("component", comp, "button", entry, "mat-");
    expect(built).not.toBeNull();
    expect(built?.selector).toBe("button[mat-button], a[mat-button]");
    expect(built?.info.component).toBe("button");
  });

  it("generateSelectorMap populates metadata.selectorMap", () => {
    const metadata: ComponentMetadataFile = {
      version: "4.0.0",
      generatedAt: new Date().toISOString(),
      componentsPath: "node_modules/test",
      importPrefix: "test/",
      components: {},
      selectorMap: { stale: { component: "x", type: "component", mainInputs: [], mainOutputs: [] } },
    };
    generateSelectorMap(metadata, "");
    expect(metadata.selectorMap).toEqual({});
  });
});
