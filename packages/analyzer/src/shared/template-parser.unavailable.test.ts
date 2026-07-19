/**
 * Simulates `@angular/compiler` being absent (it is an OPTIONAL peer
 * dependency): the mock factory throws, so the guarded top-level-await load in
 * template-parser.ts takes its catch path. Asserts that importing the modules
 * still works and every entry point degrades with the documented behavior.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@angular/compiler", () => {
  throw new Error("Cannot find package '@angular/compiler' (simulated)");
});

describe("without @angular/compiler installed", () => {
  it("template-parser imports cleanly and reports unavailability", async () => {
    const parser = await import("./template-parser.js");
    expect(parser.isAngularCompilerAvailable()).toBe(false);
    expect(() => parser.requireAngularCompiler()).toThrow(parser.AngularCompilerUnavailableError);
    expect(() => parser.requireAngularCompiler()).toThrow(/npm i -D @angular\/compiler/);
  });

  it("parseAngularTemplate throws AngularCompilerUnavailableError", async () => {
    const parser = await import("./template-parser.js");
    expect(() => parser.parseAngularTemplate("<div></div>", "test.html")).toThrow(
      parser.AngularCompilerUnavailableError,
    );
  });

  it("TemplateValidator.validate returns an angular-compiler-unavailable error", async () => {
    const { TemplateValidator } = await import("./template-validator.js");
    const validator = new TemplateValidator();
    const result = validator.validate('<mat-card [title]="x"></mat-card>');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("angular-compiler-unavailable");
    expect(result.errors[0].message).toContain("@angular/compiler");
    expect(result.warnings).toEqual([]);
  });

  it("AngularFrameworkAnalyzer.analyze fails fast with the install hint", async () => {
    const { AngularFrameworkAnalyzer } = await import("../analyzers/angular/angular-framework-analyzer.js");
    const analyzer = new AngularFrameworkAnalyzer();
    await expect(analyzer.analyze("/nonexistent")).rejects.toThrow(/@angular\/compiler is required/);
  });
});
