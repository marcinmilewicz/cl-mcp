import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  extractJsDocComment,
  extractTemplateString,
  extractTypeArgFromTypeNode,
  getDecoratorName,
  hasExportModifier,
} from "./ts-util.js";

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.ES2022, true);
}

function firstClass(sf: ts.SourceFile): ts.ClassDeclaration {
  const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s));
  if (!cls) throw new Error("no class found");
  return cls;
}

describe("ts-util", () => {
  describe("extractJsDocComment", () => {
    it("extracts a single-line JSDoc description", () => {
      const sf = parse("/** A simple description. */\nclass Foo {}");
      const cls = firstClass(sf);
      expect(extractJsDocComment(cls)).toBe("A simple description.");
    });

    it("strips @tag lines from the description", () => {
      const sf = parse("/**\n * Main description.\n * @deprecated do not use\n */\nclass Foo {}");
      const cls = firstClass(sf);
      expect(extractJsDocComment(cls)).toBe("Main description.");
    });

    it("returns undefined when no JSDoc is present", () => {
      const sf = parse("class Foo {}");
      expect(extractJsDocComment(firstClass(sf))).toBeUndefined();
    });

    it("ignores non-JSDoc block comments", () => {
      const sf = parse("/* plain comment */\nclass Foo {}");
      expect(extractJsDocComment(firstClass(sf))).toBeUndefined();
    });
  });

  describe("getDecoratorName", () => {
    it("returns the identifier for a call-style decorator", () => {
      const sf = parse(`@Component({ selector: 'x' })\nclass Foo {}`);
      const cls = firstClass(sf);
      const decorators = ts.getDecorators(cls);
      expect(decorators).toBeDefined();
      if (!decorators?.[0]) throw new Error("no decorator");
      expect(getDecoratorName(decorators[0])).toBe("Component");
    });

    it("returns the identifier for a bare decorator", () => {
      const sf = parse("@Injectable\nclass Foo {}");
      const cls = firstClass(sf);
      const decorators = ts.getDecorators(cls);
      if (!decorators?.[0]) throw new Error("no decorator");
      expect(getDecoratorName(decorators[0])).toBe("Injectable");
    });
  });

  describe("extractTypeArgFromTypeNode", () => {
    it("returns the first type argument when the type name matches", () => {
      const sf = parse("class Foo { out: EventEmitter<string>; }");
      const cls = firstClass(sf);
      const prop = cls.members[0] as ts.PropertyDeclaration;
      const typeNode = prop.type;
      if (!typeNode) throw new Error("no type");
      const arg = extractTypeArgFromTypeNode(typeNode, "EventEmitter");
      expect(arg?.getText(sf)).toBe("string");
    });

    it("returns undefined when the type name does not match", () => {
      const sf = parse("class Foo { out: Observable<number>; }");
      const cls = firstClass(sf);
      const prop = cls.members[0] as ts.PropertyDeclaration;
      if (!prop.type) throw new Error("no type");
      expect(extractTypeArgFromTypeNode(prop.type, "EventEmitter")).toBeUndefined();
    });

    it("matches any type reference when typeName is empty", () => {
      const sf = parse("class Foo { out: Box<boolean>; }");
      const cls = firstClass(sf);
      const prop = cls.members[0] as ts.PropertyDeclaration;
      if (!prop.type) throw new Error("no type");
      expect(extractTypeArgFromTypeNode(prop.type, "")?.getText(sf)).toBe("boolean");
    });

    it("returns undefined for non-reference type nodes", () => {
      const sf = parse("class Foo { s: string; }");
      const cls = firstClass(sf);
      const prop = cls.members[0] as ts.PropertyDeclaration;
      if (!prop.type) throw new Error("no type");
      expect(extractTypeArgFromTypeNode(prop.type, "")).toBeUndefined();
    });
  });

  describe("evaluateExpression", () => {
    function firstInitializer(source: string): ts.Expression {
      const sf = parse(source);
      const stmt = sf.statements[0] as ts.VariableStatement;
      const init = stmt.declarationList.declarations[0].initializer;
      if (!init) throw new Error("no initializer");
      return init;
    }

    it("evaluates primitives", () => {
      expect(evaluateExpression(firstInitializer(`const a = "hi";`))).toBe("hi");
      expect(evaluateExpression(firstInitializer("const a = 42;"))).toBe(42);
      expect(evaluateExpression(firstInitializer("const a = true;"))).toBe(true);
      expect(evaluateExpression(firstInitializer("const a = false;"))).toBe(false);
    });

    it("evaluates arrays", () => {
      expect(evaluateExpression(firstInitializer("const a = [1, 2, 3];"))).toEqual([1, 2, 3]);
    });

    it("evaluates nested object literals", () => {
      const result = evaluateExpression(firstInitializer(`const a = { x: 1, y: { z: "q" } };`));
      expect(result).toEqual({ x: 1, y: { z: "q" } });
    });

    it("falls back to source text for unrecognized expressions", () => {
      const result = evaluateExpression(firstInitializer("const a = someFn();"));
      expect(result).toBe("someFn()");
    });
  });

  describe("hasExportModifier", () => {
    it("returns true for exported declarations", () => {
      const sf = parse("export class Foo {}");
      expect(hasExportModifier(firstClass(sf))).toBe(true);
    });

    it("returns false for non-exported declarations", () => {
      const sf = parse("class Foo {}");
      expect(hasExportModifier(firstClass(sf))).toBe(false);
    });
  });

  describe("extractTemplateString", () => {
    function firstInitializer(source: string): ts.Expression {
      const sf = parse(source);
      const stmt = sf.statements[0] as ts.VariableStatement;
      const init = stmt.declarationList.declarations[0].initializer;
      if (!init) throw new Error("no initializer");
      return init;
    }

    it("extracts single-quoted strings", () => {
      expect(extractTemplateString(firstInitializer(`const a = 'hi';`))).toBe("hi");
    });

    it("extracts double-quoted strings", () => {
      expect(extractTemplateString(firstInitializer(`const a = "hi";`))).toBe("hi");
    });

    it("extracts no-substitution template literals", () => {
      expect(extractTemplateString(firstInitializer("const a = `hi`;"))).toBe("hi");
    });

    it("returns undefined for substitution template expressions", () => {
      expect(extractTemplateString(firstInitializer("const a = `hi ${1}`;"))).toBeUndefined();
    });

    it("returns undefined for non-string expressions", () => {
      expect(extractTemplateString(firstInitializer("const a = 123;"))).toBeUndefined();
    });
  });
});
