/**
 * CLI tests — a mixed React+Angular fixture workspace is analyzed with the
 * real pipeline, then every CLI command is exercised through runCli() with
 * captured output. The CLI shares the MCP server's registry, so these tests
 * also pin the CLI↔MCP parity contract.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeWorkspace } from "@cl-mcp/analyzer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __resetCliForTests, runCli } from "./main.js";

let root: string;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

function write(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-cli-"));

  write(
    "libs/ui/Button.tsx",
    `
export function Button({ variant = "primary", disabled, onClick }: {
  variant?: "primary" | "danger";
  disabled: boolean;
  onClick?: () => void;
}) {
  return <button disabled={disabled} />;
}
`,
  );

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

  delete process.env.CL_MCP_METADATA_PATH;
  delete process.env.CL_MCP_DATA_DIR;
  __resetCliForTests();
}, 60_000);

afterAll(() => {
  delete process.env.CL_MCP_DATA_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

const dataDirFlags = () => ["--data-dir", path.join(root, "data")];

describe("cl-mcp CLI", () => {
  it("prints usage and exits 2 when called without a command", async () => {
    const res = await run([]);
    expect(res.code).toBe(2);
    expect(res.stdout).toContain("Usage: cl-mcp");
  });

  it("list-libraries shows both libraries (markdown and JSON)", async () => {
    const md = await run(["list-libraries", ...dataDirFlags()]);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("| ui | @acme/ui | react | 1 |");
    expect(md.stdout).toContain("| forms | @acme/forms | angular | 1 |");

    const json = await run(["list-libraries", "--json", ...dataDirFlags()]);
    const rows = JSON.parse(json.stdout);
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(["forms", "ui"]);
  });

  it("overview renders per-library sections; --library scopes it", async () => {
    const all = await run(["overview", ...dataDirFlags()]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("# Library: ui");
    expect(all.stdout).toContain("# Library: forms");

    const scoped = await run(["overview", "--library", "ui", ...dataDirFlags()]);
    expect(scoped.stdout).toContain("@acme/ui");
    expect(scoped.stdout).not.toContain("@acme/forms");
  });

  it("get resolves across libraries and renders JSX examples for React", async () => {
    const res = await run(["get", "Button", ...dataDirFlags()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("**Library:** `ui`");
    expect(res.stdout).toContain("variant={value}");
  });

  it("get with multiple names batches", async () => {
    const res = await run(["get", "Button", "forms:input", ...dataDirFlags()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("**Library:** `ui`");
    expect(res.stdout).toContain("org-input");
  });

  it("get with an unknown name exits 1", async () => {
    const res = await run(["get", "Nonexistent", ...dataDirFlags()]);
    expect(res.code).toBe(1);
  });

  it("find searches within a scoped library", async () => {
    const res = await run(["find", "button", "--library", "ui", ...dataDirFlags()]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Button");
  });

  it("validate --code passes valid JSX and fails hallucinated props with exit 1", async () => {
    const ok = await run([
      "validate",
      "--code",
      "<Button disabled={true} />",
      "--components",
      "Button",
      ...dataDirFlags(),
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('"valid": true');

    const bad = await run([
      "validate",
      "--code",
      '<Button disabled={true} varint="x" />',
      "--components",
      "Button",
      ...dataDirFlags(),
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("variant");
  });

  it("validate without --components exits 2 with usage", async () => {
    const res = await run(["validate", "--code", "<Button />", ...dataDirFlags()]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--components");
  });
});
