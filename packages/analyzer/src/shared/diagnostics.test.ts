import { describe, expect, it } from "vitest";
import { DiagnosticsCollector } from "./diagnostics.js";

describe("DiagnosticsCollector", () => {
  it("starts empty", () => {
    const c = new DiagnosticsCollector();
    expect(c.all()).toEqual([]);
    expect(c.hasErrors()).toBe(false);
  });

  it("collects pushed diagnostics in order", () => {
    const c = new DiagnosticsCollector();
    c.push({ severity: "warn", code: "a", message: "first" });
    c.push({ severity: "warn", code: "b", message: "second" });
    const all = c.all();
    expect(all).toHaveLength(2);
    expect(all[0].code).toBe("a");
    expect(all[1].code).toBe("b");
  });

  it("hasErrors() returns true iff any severity==='error'", () => {
    const c = new DiagnosticsCollector();
    c.push({ severity: "warn", code: "x", message: "warn-only" });
    expect(c.hasErrors()).toBe(false);
    c.push({ severity: "error", code: "y", message: "boom" });
    expect(c.hasErrors()).toBe(true);
  });

  it("all() returns a copy (mutations do not leak in)", () => {
    const c = new DiagnosticsCollector();
    c.push({ severity: "warn", code: "a", message: "m" });
    const snapshot = c.all();
    snapshot.push({ severity: "error", code: "injected", message: "nope" });
    expect(c.all()).toHaveLength(1);
    expect(c.hasErrors()).toBe(false);
  });
});
