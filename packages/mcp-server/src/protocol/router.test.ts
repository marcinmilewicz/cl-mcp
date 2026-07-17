/**
 * Multi-library integration tests: a mixed React+Angular workspace is
 * analyzed with the real analyzer pipeline, loaded through CL_MCP_DATA_DIR
 * into the registry, and exercised through the actual tool handlers.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeWorkspace } from "@cl-mcp/analyzer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPreloadedMetadata } from "../data/metadata.js";
import { __resetRegistryForTests, getLibraryNames, isMultiLibrary, resolveLibraryQualifier } from "../data/registry.js";
import { registerToolHandlers } from "./router.js";

let root: string;
let callTool: (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: true }>;

function write(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-multi-"));

  write(
    "libs/ui/Button.tsx",
    `
/** A clickable button. */
export function Button({ variant = "primary", disabled, onClick, children }: {
  variant?: "primary" | "danger";
  disabled: boolean;
  onClick?: (id: string) => void;
  children?: unknown;
}) {
  return <button disabled={disabled}>{children}</button>;
}
`,
  );

  write(
    "libs/forms/input/input.component.ts",
    `
import { Component, Input, Output, EventEmitter } from "@angular/core";

@Component({ selector: "org-input", standalone: true, template: "<input [value]='value'/>" })
export class OrgInput {
  @Input({ required: true }) value!: string;
  @Output() valueChange = new EventEmitter<string>();
}
`,
  );

  await analyzeWorkspace(
    {
      outputDir: "./data",
      libraries: [
        { path: "libs/ui", framework: "react", importAlias: "@acme/ui" },
        { path: "libs/forms", framework: "angular", importAlias: "@acme/forms", prefix: "org-" },
      ],
    },
    root,
  );

  process.env.CL_MCP_DATA_DIR = path.join(root, "data");
  delete process.env.CL_MCP_METADATA_PATH;
  loadPreloadedMetadata();

  // Capture the CallTool handler through a fake Server.
  let captured: ((request: unknown) => Promise<unknown>) | null = null;
  const fakeServer = {
    setRequestHandler: (_schema: unknown, handler: (request: unknown) => Promise<unknown>) => {
      captured = handler;
    },
  };
  registerToolHandlers(fakeServer as never);
  if (!captured) throw new Error("handler not captured");
  const handler = captured as (request: unknown) => Promise<unknown>;
  callTool = (name, args) => handler({ params: { name, arguments: args } }) as ReturnType<typeof callTool>;
}, 60_000);

afterAll(() => {
  delete process.env.CL_MCP_DATA_DIR;
  __resetRegistryForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("registry", () => {
  it("loads both libraries and reports multi-library mode", () => {
    expect(getLibraryNames().sort()).toEqual(["forms", "ui"]);
    expect(isMultiLibrary()).toBe(true);
  });

  it("resolves qualifiers by name and package alias", () => {
    expect(resolveLibraryQualifier("ui")).toBe("ui");
    expect(resolveLibraryQualifier("@acme/forms")).toBe("forms");
    expect(resolveLibraryQualifier("nope")).toBeNull();
  });
});

describe("get_library_overview", () => {
  it("returns one section per library when unscoped", async () => {
    const res = await callTool("get_library_overview", {});
    expect(res.content[0].text).toContain("# Library: ui");
    expect(res.content[0].text).toContain("# Library: forms");
    expect(res.content[0].text).toContain("@acme/ui");
  });

  it("scopes to a single library via the library argument", async () => {
    const res = await callTool("get_library_overview", { library: "ui" });
    expect(res.content[0].text).toContain("@acme/ui");
    expect(res.content[0].text).not.toContain("@acme/forms");
  });

  it("rejects an unknown library", async () => {
    const res = await callTool("get_library_overview", { library: "zzz" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("unknown library");
  });
});

describe("get_component across libraries", () => {
  it("resolves an unqualified unique name and names the owning library", async () => {
    const res = await callTool("get_component", { componentName: "Button" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("**Library:** `ui`");
    expect(res.content[0].text).toContain("disabled");
  });

  it("supports lib:Name qualifiers", async () => {
    const res = await callTool("get_component", { componentName: "forms:input" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("**Library:** `forms`");
    expect(res.content[0].text).toContain("org-input");
  });

  it("errors with library list when the name matches nowhere", async () => {
    const res = await callTool("get_component", { componentName: "Nonexistent" });
    expect(res.isError).toBe(true);
  });

  it("renders React binding examples in JSX syntax", async () => {
    const res = await callTool("get_component", { componentName: "ui:Button" });
    expect(res.content[0].text).toContain("variant={value}");
    expect(res.content[0].text).not.toContain('[variant]="value"');
  });
});

describe("get_components_batch", () => {
  it("resolves each name independently across libraries", async () => {
    const res = await callTool("get_components_batch", { componentNames: ["Button", "input", "Missing"] });
    const text = res.content[0].text;
    expect(text).toContain("**Library:** `ui`");
    expect(text).toContain("**Library:** `forms`");
    expect(text).toContain("# Missing");
    expect(text).toContain("Error");
  });
});

describe("validation", () => {
  it("validate_usage validates JSX against the React library", async () => {
    const res = await callTool("validate_usage", {
      code: `<Button disabled={true} variant="danger" />`,
      componentNames: ["Button"],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"valid": true');
  });

  it("validate_usage flags hallucinated props with suggestions", async () => {
    const res = await callTool("validate_usage", {
      code: `<Button disabled={true} varint="danger" />`,
      componentNames: ["Button"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("variant");
  });

  it("validate_usage dispatches Angular libraries to the template validator", async () => {
    const res = await callTool("validate_usage", {
      code: `<org-input [value]="x"></org-input>`,
      componentNames: ["input"],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"valid": true');
  });

  it("validate_template refuses React libraries and points to validate_usage", async () => {
    const res = await callTool("validate_template", {
      template: "<Button disabled={true} />",
      componentNames: ["Button"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("validate_usage");
  });

  it("validate_template still validates Angular templates", async () => {
    const res = await callTool("validate_template", {
      template: `<org-input [value]="x"></org-input>`,
      componentNames: ["input"],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"valid": true');
  });
});

describe("find_components", () => {
  it("returns per-library sections when unscoped", async () => {
    const res = await callTool("find_components", {});
    expect(res.content[0].text).toContain("# Library: ui");
    expect(res.content[0].text).toContain("# Library: forms");
  });

  it("scopes search to one library", async () => {
    const res = await callTool("find_components", { query: "button", library: "ui" });
    expect(res.content[0].text).toContain("Button");
    expect(res.content[0].text).not.toContain("org-input");
  });
});
