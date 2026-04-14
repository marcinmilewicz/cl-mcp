import { describe, expect, it } from "vitest";
import { TemplateParseCache, parseAngularTemplate, walkTemplate } from "./template-parser.js";

describe("parseAngularTemplate", () => {
  it("parses empty template to empty nodes with no errors", () => {
    const r = parseAngularTemplate("", "empty.html");
    expect(r.nodes).toEqual([]);
    // `errors` is `null | ParseError[]`; both represent no errors.
    expect(r.errors == null || r.errors.length === 0).toBe(true);
  });

  it("parses simple element with attributes and visits via walker", () => {
    const r = parseAngularTemplate('<div class="x" id="y"></div>', "el.html");
    expect(r.errors == null || r.errors.length === 0).toBe(true);

    const elements: { name: string; attrs: Record<string, string> }[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        const attrs: Record<string, string> = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        elements.push({ name: el.name, attrs });
      },
    });

    expect(elements).toHaveLength(1);
    expect(elements[0].name).toBe("div");
    expect(elements[0].attrs).toEqual({ class: "x", id: "y" });
  });

  it("descends into @if branch", () => {
    const r = parseAngularTemplate("@if (cond) { <div></div> }", "if.html");
    const seen: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        seen.push(el.name);
      },
      visitIfBlock() {
        seen.push("@if");
      },
    });
    expect(seen).toContain("@if");
    expect(seen).toContain("div");
  });

  it("descends into @for body", () => {
    const r = parseAngularTemplate("@for (x of xs; track x) { <div></div> }", "for.html");
    const seen: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        seen.push(el.name);
      },
      visitForLoopBlock() {
        seen.push("@for");
      },
    });
    expect(seen).toContain("@for");
    expect(seen).toContain("div");
  });

  it("descends into @for empty branch", () => {
    const r = parseAngularTemplate("@for (x of xs; track x) { <div></div> } @empty { <em></em> }", "forempty.html");
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        names.push(el.name);
      },
    });
    expect(names).toEqual(expect.arrayContaining(["div", "em"]));
  });

  it("descends into @switch cases", () => {
    const r = parseAngularTemplate("@switch (x) { @case (1) { <div></div> } @default { <em></em> } }", "switch.html");
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        names.push(el.name);
      },
    });
    expect(names).toEqual(expect.arrayContaining(["div", "em"]));
  });

  it("descends into @defer loading branch", () => {
    const r = parseAngularTemplate("@defer { <div></div> } @loading { <span></span> }", "defer.html");
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        names.push(el.name);
      },
      visitDeferredBlock() {
        names.push("@defer");
      },
    });
    expect(names).toContain("@defer");
    expect(names).toEqual(expect.arrayContaining(["div", "span"]));
  });

  it("descends into @defer @error branch", () => {
    const r = parseAngularTemplate("@defer { <div></div> } @error { <span></span> }", "defer-error.html");
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        names.push(el.name);
      },
    });
    expect(names).toEqual(expect.arrayContaining(["div", "span"]));
  });

  it("descends into @defer @placeholder branch", () => {
    const r = parseAngularTemplate(
      "@defer { <div></div> } @placeholder { <span></span> }",
      "defer-placeholder.html",
    );
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitElement(el) {
        names.push(el.name);
      },
    });
    expect(names).toEqual(expect.arrayContaining(["div", "span"]));
  });

  it("descends into ng-template children", () => {
    const r = parseAngularTemplate("<ng-template><div></div></ng-template>", "tpl.html");
    const names: string[] = [];
    walkTemplate(r.nodes, {
      visitTemplate() {
        names.push("ng-template");
      },
      visitElement(el) {
        names.push(el.name);
      },
    });
    expect(names).toEqual(["ng-template", "div"]);
  });

  it("returns errors[] but nodes present on malformed template", () => {
    // Unclosed attribute bracket — parser reports an error but still returns
    // a best-effort node tree.
    const r = parseAngularTemplate('<div [foo="bar"></div>', "bad.html");
    expect(r.errors).not.toBeNull();
    expect((r.errors ?? []).length).toBeGreaterThan(0);
    expect(r.nodes.length).toBeGreaterThan(0);
  });
});

describe("TemplateParseCache", () => {
  it("returns identical reference for same template + sourceUrl", () => {
    const cache = new TemplateParseCache();
    const a = cache.get("<div></div>", "x.html");
    const b = cache.get("<div></div>", "x.html");
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it("distinguishes by sourceUrl", () => {
    const cache = new TemplateParseCache();
    const a = cache.get("<div></div>", "x.html");
    const b = cache.get("<div></div>", "y.html");
    expect(a).not.toBe(b);
    expect(cache.size).toBe(2);
  });

  it("distinguishes by template content", () => {
    const cache = new TemplateParseCache();
    const a = cache.get("<div></div>", "x.html");
    const b = cache.get("<span></span>", "x.html");
    expect(a).not.toBe(b);
    expect(cache.size).toBe(2);
  });
});
