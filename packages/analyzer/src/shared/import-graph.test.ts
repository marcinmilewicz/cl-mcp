/**
 * Phase 0 tests for import-graph's findRelatedComponents.
 *
 * Focus: the theming / prebuilt-themes filtering gap. The current code
 * filters only 'core' and 'cdk'; anything else (e.g. 'theming',
 * 'prebuilt-themes') is passed through as a "requires" relationship.
 * That is bug M6/related — this test captures CURRENT behavior so Phase 3
 * can flip the assertion once a proper register is introduced.
 */

import { describe, expect, it } from "vitest";
import { type ImportGraph, buildStorybookCooccurrences, findRelatedComponents } from "./import-graph.js";

function makeGraph(entries: Record<string, { imports: string[]; importedBy?: string[] }>): ImportGraph {
  const map = new Map();
  for (const [name, e] of Object.entries(entries)) {
    map.set(name, {
      component: name,
      imports: e.imports,
      importedBy: e.importedBy ?? [],
    });
  }
  return { entries: map };
}

describe("findRelatedComponents — theming / prebuilt-themes filtering", () => {
  it("filters 'core', 'cdk', 'theming', and 'prebuilt-themes' via the non-component register (M6 fixed)", () => {
    const graph = makeGraph({
      button: { imports: ["core", "cdk", "theming", "prebuilt-themes", "icon"] },
      icon: { imports: [] },
      theming: { imports: [] },
      "prebuilt-themes": { imports: [] },
    });

    const related = findRelatedComponents("button", graph);
    const names = related.map((r) => r.name);

    // Non-component subpackages must all be filtered.
    expect(names).not.toContain("core");
    expect(names).not.toContain("cdk");
    expect(names).not.toContain("theming");
    expect(names).not.toContain("prebuilt-themes");

    // Real user-facing sibling remains.
    expect(names).toContain("icon");
  });

  it("merges storybook co-occurrences as 'often-used-with' without dup-listing direct imports", () => {
    const graph = makeGraph({
      button: { imports: ["icon"] },
      icon: { imports: [] },
      tooltip: { imports: [] },
    });
    const cooccurrences = new Map<string, string[]>([["button", ["icon", "tooltip"]]]);

    const related = findRelatedComponents("button", graph, cooccurrences);
    const byName = Object.fromEntries(related.map((r) => [r.name, r]));

    expect(byName.icon.relationship).toBe("requires");
    expect(byName.tooltip.relationship).toBe("often-used-with");
  });

  it("returns an empty list for unknown components", () => {
    const graph = makeGraph({ button: { imports: [] } });
    expect(findRelatedComponents("nope", graph)).toEqual([]);
  });
});

describe("buildStorybookCooccurrences — attribute-directive-only pairings (plan-2 Commit 5 KPI)", () => {
  it("emits a co-occurrence edge when two examples share ONLY an attribute directive", () => {
    // Two different components' examples both use the `tooltip` attribute
    // directive but share no element selectors. The pre-Commit-5 regex
    // extractor would have missed this entirely (regex couldn't see attrs).
    // The resolve pass stores component NAMES in `usedComponents`, so the
    // cooccurrence builder must now emit `button <-> tooltip` and
    // `icon <-> tooltip` edges purely from attribute-directive sharing.
    const storybookExamples = new Map<string, Array<{ usedComponents: string[] }>>([
      ["button", [{ usedComponents: ["button", "tooltip"] }]],
      ["icon", [{ usedComponents: ["icon", "tooltip"] }]],
    ]);

    const co = buildStorybookCooccurrences(storybookExamples);

    expect(co.get("button")).toContain("tooltip");
    expect(co.get("tooltip")).toEqual(expect.arrayContaining(["button", "icon"]));
    expect(co.get("icon")).toContain("tooltip");
  });
});
