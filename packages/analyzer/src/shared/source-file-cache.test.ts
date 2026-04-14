/**
 * Unit tests for SourceFileCache (Phase 2).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceFileCache } from "./source-file-cache.js";

const tmpRoot = path.join(os.tmpdir(), `cl-mcp-sf-cache-test-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SourceFileCache", () => {
  it("miss → reads from disk, parses, returns a SourceFile", () => {
    const filePath = path.join(tmpRoot, "miss.ts");
    fs.writeFileSync(filePath, "export const x = 1;\n", "utf-8");

    const cache = new SourceFileCache();
    const sf = cache.get(filePath);
    expect(sf).toBeDefined();
    expect(sf?.fileName).toBe(filePath);
    expect(cache.has(filePath)).toBe(true);
  });

  it("hit → returns the same instance on repeated lookups", () => {
    const filePath = path.join(tmpRoot, "hit.ts");
    fs.writeFileSync(filePath, "export const y = 2;\n", "utf-8");

    const cache = new SourceFileCache();
    const first = cache.get(filePath);
    const second = cache.get(filePath);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("set then get → returns the pre-populated instance without touching disk", () => {
    const fakePath = path.join(tmpRoot, "does-not-exist-on-disk.ts");
    const sf = ts.createSourceFile(fakePath, "export const z = 3;", ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const cache = new SourceFileCache();
    cache.set(fakePath, sf);
    expect(cache.has(fakePath)).toBe(true);
    expect(cache.get(fakePath)).toBe(sf);
  });
});
