/**
 * Tests for StorybookExtractor.
 *
 * `extractPrefixedTemplate` and `storyNameFromFile` are private; we access them
 * through an `any`-cast so the test suite can pin their behavior without
 * widening the public API.
 */

import { describe, expect, it } from "vitest";
import { TemplateParseCache } from "../../shared/template-parser.js";
import type { StorybookExample } from "../../types.js";
import { asFilePath } from "../../types.js";
import { StorybookExtractor } from "./storybook-extractor.js";

function withPrivates(extractor: StorybookExtractor) {
  // biome-ignore lint/suspicious/noExplicitAny: access privates for unit tests
  return extractor as any as {
    extractPrefixedTemplate(template: string): string | null;
    storyNameFromFile(filename: string): string;
    extractUsedComponents(template: string, sourceUrl: string, example: StorybookExample): string[];
  };
}

describe("extractPrefixedTemplate — nested same-prefix tags", () => {
  it("returns the outer element intact when same-prefix tags are nested", () => {
    const extractor = new StorybookExtractor("/not/used", "ui-", new TemplateParseCache());
    const template = `
      <sb-wrapper>
        <ui-card>
          <ui-button label="ok" />
          <ui-button label="cancel" />
        </ui-card>
      </sb-wrapper>
    `;

    const result = withPrivates(extractor).extractPrefixedTemplate(template);
    expect(result).toBeTruthy();
    expect(result?.trim().startsWith("<ui-card")).toBe(true);
    expect(result).toContain('label="ok"');
    expect(result).toContain('label="cancel"');
    expect(result?.trim().endsWith("</ui-card>")).toBe(true);
  });

  it("returns the template as-is when no prefix is configured", () => {
    const extractor = new StorybookExtractor("/not/used", "", new TemplateParseCache());
    const template = "<div>plain</div>";
    expect(withPrivates(extractor).extractPrefixedTemplate(template)).toBe("<div>plain</div>");
  });

  it("returns null when no matching prefixed element is present", () => {
    const extractor = new StorybookExtractor("/not/used", "ui-", new TemplateParseCache());
    expect(withPrivates(extractor).extractPrefixedTemplate("<sb-wrap><div></div></sb-wrap>")).toBeNull();
  });
});

describe("extractUsedComponents — rawTemplateTokens", () => {
  it("populates elements + attributes from AST walk", () => {
    const extractor = new StorybookExtractor("/not/used", "mat-", new TemplateParseCache());
    const template = '<button mat-button matTooltip="hi"><mat-icon>add</mat-icon></button>';
    const example: StorybookExample = {
      storyName: "Demo",
      filePath: asFilePath("demo.stories.ts"),
      template,
      args: {},
      usedComponents: [],
    };
    withPrivates(extractor).extractUsedComponents(template, "demo.html", example);
    const tokens = extractor.rawTemplateTokens.get(example);
    expect(tokens).toBeDefined();
    expect(tokens?.elements).toEqual(expect.arrayContaining(["mat-icon"]));
    expect(tokens?.attributes).toEqual(expect.arrayContaining(["mat-button", "matTooltip"]));
  });
});

describe("storyNameFromFile", () => {
  it("turns a multi-segment filename into a Title-Cased story name", () => {
    const extractor = new StorybookExtractor("/not/used", "ui-", new TemplateParseCache());
    const result = withPrivates(extractor).storyNameFromFile("ui-button-with-icon.story.ts");
    expect(result).toBe("Button With Icon");
  });

  it("strips only the configured prefix before title-casing", () => {
    const extractor = new StorybookExtractor("/not/used", "ui-", new TemplateParseCache());
    const result = withPrivates(extractor).storyNameFromFile("ui-button.story.ts");
    expect(result).toBe("Button");
  });
});
