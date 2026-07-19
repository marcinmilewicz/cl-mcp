/**
 * Tests for the workspace layer: config loading/validation, framework
 * detection, library discovery (explicit + scan + aliases), and the full
 * orchestrator run over a mixed Angular+React fixture workspace.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "../shared/diagnostics.js";
import { loadWorkspaceConfig } from "./config.js";
import { detectFramework } from "./framework-detector.js";
import { matchesAnyGlob, resolveLibraries } from "./library-discovery.js";
import { analyzeWorkspace, buildCrossLibraryGraph } from "./workspace-orchestrator.js";

let root: string;

function write(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-ws-"));

  // React library: libs/icons (flat)
  write("libs/icons/Icon.tsx", `export function Icon({ name }: { name: string }) { return <i data-icon={name} />; }`);

  // React library: libs/ui (flat), imports icons via alias
  write(
    "libs/ui/Button.tsx",
    `
import { Icon } from "@acme/icons";
export function Button({ disabled, children }: { disabled: boolean; children?: unknown }) {
  return <button disabled={disabled}><Icon name="x" />{children}</button>;
}
`,
  );

  // Angular library: libs/forms (directory-per-component)
  write(
    "libs/forms/input/input.component.ts",
    `
import { Component, Input } from "@angular/core";

@Component({ selector: "org-input", standalone: true, template: "<input [value]='value'/>" })
export class OrgInput {
  @Input({ required: true }) value!: string;
}
`,
  );

  // Excluded-by-glob candidate + a non-library dir the scan should skip
  write("libs/forms-e2e/test.spec.ts", "export const x = 1;");
  write("libs/empty/notes.txt", "not a library");

  // tsconfig paths → aliases
  write(
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@acme/icons": ["libs/icons/Icon.tsx"],
          "@acme/ui": ["libs/ui/Button.tsx"],
          "@acme/forms": ["libs/forms/input/input.component.ts"],
        },
      },
    }),
  );

  write(
    "cl-mcp.yaml",
    `
outputDir: ./data
libraries:
  - path: libs/forms
    framework: angular
    prefix: org-
scan:
  - dir: libs
    exclude: ["*-e2e"]
`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadWorkspaceConfig", () => {
  it("parses YAML and validates the shape", () => {
    const loaded = loadWorkspaceConfig(path.join(root, "cl-mcp.yaml"));
    expect(loaded.config.outputDir).toBe("./data");
    expect(loaded.config.libraries?.[0].framework).toBe("angular");
    expect(loaded.rootDir).toBe(root);
  });

  it("fails loudly on unknown keys", () => {
    const bad = path.join(root, "bad.yaml");
    fs.writeFileSync(bad, "libraries:\n  - path: libs/ui\n    framwork: react\n");
    expect(() => loadWorkspaceConfig(bad)).toThrow(/framwork/);
  });

  it("requires libraries or scan", () => {
    const empty = path.join(root, "empty.yaml");
    fs.writeFileSync(empty, "outputDir: ./data\n");
    expect(() => loadWorkspaceConfig(empty)).toThrow(/libraries.*scan|scan.*libraries/);
  });
});

describe("detectFramework", () => {
  it("detects react from .tsx sources", () => {
    expect(detectFramework(path.join(root, "libs/ui"))).toBe("react");
  });

  it("detects angular from @Component decorators", () => {
    expect(detectFramework(path.join(root, "libs/forms"))).toBe("angular");
  });

  it("returns null for a directory with no framework signals", () => {
    expect(detectFramework(path.join(root, "libs/empty"))).toBeNull();
  });
});

describe("resolveLibraries", () => {
  it("merges explicit entries with scan results, applies excludes and aliases", () => {
    const { config } = loadWorkspaceConfig(path.join(root, "cl-mcp.yaml"));
    const diagnostics = new DiagnosticsCollector();
    const libs = resolveLibraries(config, root, diagnostics);

    const names = libs.map((l) => l.name).sort();
    expect(names).toEqual(["forms", "icons", "ui"]);

    const forms = libs.find((l) => l.name === "forms");
    expect(forms?.framework).toBe("angular");
    expect(forms?.selectorPrefix).toBe("org-");
    expect(forms?.importAlias).toBe("@acme/forms");

    const ui = libs.find((l) => l.name === "ui");
    expect(ui?.framework).toBe("react");
    expect(ui?.importAlias).toBe("@acme/ui");

    // forms-e2e excluded by glob, empty skipped with a diagnostic
    expect(names).not.toContain("forms-e2e");
    expect(diagnostics.all().some((d) => d.code === "library-skipped")).toBe(true);
  });
});

describe("matchesAnyGlob", () => {
  it("matches * wildcards and literals", () => {
    expect(matchesAnyGlob("forms-e2e", ["*-e2e"])).toBe(true);
    expect(matchesAnyGlob("forms", ["*-e2e"])).toBe(false);
    expect(matchesAnyGlob("testing", ["testing"])).toBe(true);
  });
});

describe("analyzeWorkspace (end to end over the fixture)", () => {
  it("writes per-library metadata + manifest with a cross-library graph", async () => {
    const { config } = loadWorkspaceConfig(path.join(root, "cl-mcp.yaml"));
    const result = await analyzeWorkspace(config, root);

    // Per-library metadata files exist and carry the right framework.
    const uiMeta = JSON.parse(fs.readFileSync(path.join(root, "data/ui/component-metadata.json"), "utf-8"));
    expect(uiMeta.framework).toBe("react");
    expect(uiMeta.libraryName).toBe("@acme/ui");
    expect(Object.keys(uiMeta.components)).toEqual(["Button"]);

    const formsMeta = JSON.parse(fs.readFileSync(path.join(root, "data/forms/component-metadata.json"), "utf-8"));
    expect(formsMeta.framework).toBe("angular");
    expect(formsMeta.selectorMap["org-input"]).toBeDefined();

    // Manifest lists all three libraries and the ui → icons alias edge.
    expect(result.manifest.libraries.map((l) => l.name).sort()).toEqual(["forms", "icons", "ui"]);
    expect(result.manifest.crossLibraryGraph.ui).toEqual(["icons"]);
    expect(result.manifest.crossLibraryGraph.icons).toEqual([]);

    const manifestOnDisk = JSON.parse(fs.readFileSync(path.join(root, "data/workspace-manifest.json"), "utf-8"));
    expect(manifestOnDisk.libraries).toHaveLength(3);
  });
});

describe("buildCrossLibraryGraph", () => {
  it("detects relative imports escaping into a sibling library", () => {
    const relRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-rel-"));
    try {
      fs.mkdirSync(path.join(relRoot, "shared"), { recursive: true });
      fs.mkdirSync(path.join(relRoot, "app-ui"), { recursive: true });
      fs.writeFileSync(path.join(relRoot, "shared/util.ts"), "export const u = 1;");
      fs.writeFileSync(
        path.join(relRoot, "app-ui/Thing.tsx"),
        'import { u } from "../shared/util";\nexport function Thing() { return <div>{u}</div>; }',
      );

      const libs = [
        {
          name: "shared",
          path: path.join(relRoot, "shared"),
          framework: "react",
          importAlias: "shared",
          selectorPrefix: "",
          componentLayout: "auto",
        },
        {
          name: "app-ui",
          path: path.join(relRoot, "app-ui"),
          framework: "react",
          importAlias: "app-ui",
          selectorPrefix: "",
          componentLayout: "auto",
        },
      ] as const;

      const graph = buildCrossLibraryGraph(libs as never, relRoot);
      expect(graph["app-ui"]).toEqual(["shared"]);
    } finally {
      fs.rmSync(relRoot, { recursive: true, force: true });
    }
  });
});
