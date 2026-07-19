/**
 * Integration test for ReactFrameworkAnalyzer: a small on-disk fixture library
 * goes through the full analyze() pipeline (discovery → program → entries →
 * selector map → storybook → related components).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComponentMetadataFile } from "../../types.js";
import { ReactFrameworkAnalyzer } from "./react-framework-analyzer.js";

let libDir: string;
let metadata: ComponentMetadataFile;

beforeAll(async () => {
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-mcp-react-"));

  fs.writeFileSync(
    path.join(libDir, "Button.tsx"),
    `
/** A styled push-button. */
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

  fs.writeFileSync(
    path.join(libDir, "Card.tsx"),
    `
import { Button } from "./Button";

export const Card = ({ title }: { title: string }) => (
  <div>
    <h1>{title}</h1>
    <Button disabled={false} />
  </div>
);
`,
  );

  fs.writeFileSync(
    path.join(libDir, "Button.stories.tsx"),
    `
import { Button } from "./Button";
import { Card } from "./Card";

export default { title: "Button", component: Button };

export const Primary = {
  args: { variant: "primary", disabled: false },
  render: (args: Record<string, unknown>) => (
    <Card title="demo">
      <Button disabled={false} {...args} />
    </Card>
  ),
};
`,
  );

  metadata = await new ReactFrameworkAnalyzer().analyze(libDir, { packageName: "@acme/ui" });
});

afterAll(() => {
  fs.rmSync(libDir, { recursive: true, force: true });
});

describe("ReactFrameworkAnalyzer.analyze", () => {
  it("emits schema v4.2 with framework=react and libraryName", () => {
    expect(metadata.framework).toBe("react");
    expect(metadata.libraryName).toBe("@acme/ui");
    expect(metadata.version).toBe("4.2.0");
  });

  it("creates one entry per detected component", () => {
    expect(Object.keys(metadata.components).sort()).toEqual(["Button", "Card"]);
    const button = metadata.components.Button;
    expect(button.kind).toBe("analyzed");
    if (button.kind !== "analyzed") return;
    expect(button.files).toEqual(["Button.tsx"]);
    expect(button.contentProjection?.map((s) => s.name)).toEqual(["children"]);
  });

  it("builds a selector map keyed by JSX names with required markers", () => {
    const button = metadata.selectorMap?.Button;
    expect(button).toBeDefined();
    expect(button?.mainInputs).toContain("disabled*");
    expect(button?.mainOutputs).toEqual(["onClick"]);
    expect(button?.hasContentSlots).toBe(true);
  });

  it("derives a requires edge from Card's import of Button", () => {
    const card = metadata.components.Card;
    if (card.kind !== "analyzed") throw new Error("Card not analyzed");
    expect(card.importsFrom).toEqual(["Button"]);
    expect(card.relatedComponents?.some((r) => r.name === "Button" && r.relationship === "requires")).toBe(true);
  });

  it("extracts CSF stories with args and resolves usedComponents from render JSX", () => {
    const button = metadata.components.Button;
    if (button.kind !== "analyzed") throw new Error("Button not analyzed");
    expect(button.storybookExamples).toHaveLength(1);
    const story = button.storybookExamples?.[0];
    expect(story?.storyName).toBe("Primary");
    expect(story?.args).toEqual({ variant: "primary", disabled: false });
    expect(story?.usedComponents).toEqual(["Button", "Card"]);
    expect(story?.template).toContain("<Card");
  });

  it("emits an often-used-with edge from storybook co-occurrence", () => {
    const card = metadata.components.Card;
    if (card.kind !== "analyzed") throw new Error("Card not analyzed");
    expect(card.relatedComponents?.some((r) => r.name === "Button")).toBe(true);
  });
});
