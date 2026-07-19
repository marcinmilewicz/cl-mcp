/**
 * Compound naming tests: namespace barrels (`export * as Dialog from
 * './index.parts'`) rename detected components to their public compound
 * names (`Dialog.Root`), while internal declaration names stay reachable
 * (exports, JSX validation).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComponentMetadataFile } from "../../types.js";
import { JsxValidator } from "./jsx-validator.js";
import { ReactFrameworkAnalyzer } from "./react-framework-analyzer.js";

let libDir: string;
let metadata: ComponentMetadataFile;

function write(relPath: string, content: string): void {
  const abs = path.join(libDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-compound-"));

  write(
    "dialog/root/DialogRoot.tsx",
    `
/** Groups all parts of the dialog. */
export function DialogRoot({ open, modal }: { open?: boolean; modal: boolean }) {
  return <div data-open={open} data-modal={modal} />;
}
`,
  );
  write(
    "dialog/popup/DialogPopup.tsx",
    `
export function DialogPopup({ keepMounted }: { keepMounted?: boolean }) {
  return <section data-keep={keepMounted} />;
}
`,
  );
  write(
    "dialog/index.parts.ts",
    `
export { DialogRoot as Root } from "./root/DialogRoot";
export { DialogPopup as Popup } from "./popup/DialogPopup";
`,
  );
  write(
    "dialog/index.ts",
    `
export * as Dialog from "./index.parts";
`,
  );
  // A component NOT published through any namespace keeps its flat name.
  write(
    "Button.tsx",
    `
export function Button({ disabled }: { disabled: boolean }) {
  return <button disabled={disabled} />;
}
`,
  );

  metadata = await new ReactFrameworkAnalyzer().analyze(libDir, { packageName: "@acme/headless" });
});

afterAll(() => {
  fs.rmSync(libDir, { recursive: true, force: true });
});

describe("compound naming", () => {
  it("keys namespace-published components by their compound name", () => {
    expect(Object.keys(metadata.components).sort()).toEqual(["Button", "Dialog.Popup", "Dialog.Root"]);
  });

  it("uses the compound name as the JSX selector and keeps the internal name in exports/className", () => {
    const entry = metadata.components["Dialog.Root"];
    if (entry.kind !== "analyzed") throw new Error("Dialog.Root not analyzed");
    expect(entry.exports).toEqual(["DialogRoot"]);
    const component = entry.analysis[0].components[0];
    expect(component.className).toBe("DialogRoot");
    expect(component.metadata.selector).toBe("Dialog.Root");
    expect(metadata.selectorMap?.["Dialog.Root"]).toBeDefined();
    expect(metadata.selectorMap?.DialogRoot).toBeUndefined();
  });

  it("leaves non-namespaced components untouched", () => {
    const entry = metadata.components.Button;
    if (entry.kind !== "analyzed") throw new Error("Button not analyzed");
    expect(entry.analysis[0].components[0].metadata.selector).toBe("Button");
  });

  it("JsxValidator accepts BOTH <Dialog.Root> and <DialogRoot> usages", () => {
    const entry = metadata.components["Dialog.Root"];
    if (entry.kind !== "analyzed") throw new Error("Dialog.Root not analyzed");
    const validator = new JsxValidator();
    validator.registerFromAnalysis(entry.analysis);

    expect(validator.validate("<Dialog.Root modal={true} />").errors).toEqual([]);
    expect(validator.validate("<DialogRoot modal={true} />").errors).toEqual([]);

    const bad = validator.validate('<Dialog.Root modal={true} opne="x" />');
    expect(bad.errors.some((e) => e.type === "unknown-input" && "suggestion" in e && e.suggestion === "open")).toBe(
      true,
    );
    const missing = validator.validate("<Dialog.Root open />");
    expect(missing.errors.some((e) => e.type === "missing-required" && "property" in e && e.property === "modal")).toBe(
      true,
    );
  });
});
