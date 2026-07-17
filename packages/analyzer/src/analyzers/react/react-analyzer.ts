/**
 * React AST Analyzer
 *
 * Extracts component metadata from React TypeScript sources using the
 * TypeScript compiler API. Emits the SAME structural shapes as the Angular
 * analyzer (`FileAnalysis` / `ComponentAnalysis`) so every downstream
 * consumer (selector map, MCP server, search, formatters) works unchanged:
 *
 *   - `metadata.selector`  = the component's JSX name (e.g. `Button`)
 *   - `inputs`             = props (minus callback props)
 *   - `outputs`            = callback props (`/^on[A-Z]/` with a call signature)
 *   - content slots        = `children` + props typed as ReactNode/ReactElement
 *
 * Detection covers: exported function declarations, arrow/function-expression
 * consts, `React.FC<P>` annotations, `forwardRef()` / `memo()` wrappers
 * (unwrapped recursively), and class components (`extends React.Component<P>`).
 *
 * Honest degradation: anything the analyzer cannot resolve becomes
 * `typeResolved: false` plus a diagnostic — never a silent guess.
 */

import ts from "typescript";
import type { DiagnosticsCollector } from "../../shared/diagnostics.js";
import type {
  ComponentAnalysis,
  ContentSlotInfo,
  DeprecationInfo,
  ExportedType,
  FileAnalysis,
  InputProperty,
  OutputProperty,
  ResolvedValues,
  TypeMember,
} from "../../types.js";
import { asClassName, asFilePath, asSelector } from "../../types.js";

// ============================================================================
// Public result shape
// ============================================================================

/** Per-file analysis plus the React-specific slot info per component. */
export interface ReactFileAnalysis {
  analysis: FileAnalysis;
  /** Content slots per component className (children / ReactNode props). */
  slots: Map<string, ContentSlotInfo[]>;
  /** Component-level deprecation per className. */
  deprecations: Map<string, DeprecationInfo>;
}

export interface ReactAnalyzerOptions {
  /**
   * When true, props inherited from React/DOM ambient types
   * (`@types/react`, `typescript/lib`) are kept. Default: filtered out —
   * otherwise every component styled over `HTMLAttributes` reports hundreds
   * of props.
   */
  includeDomProps?: boolean;
}

// ============================================================================
// Analyzer
// ============================================================================

const CALLBACK_NAME = /^on[A-Z]/;
const SLOT_TYPE = /\b(?:ReactNode|ReactElement|JSX\.Element)\b/;
/** Prop names that are React plumbing, never part of a component's public API. */
const IGNORED_PROPS = new Set(["key", "ref"]);

export class ReactAstAnalyzer {
  private program: ts.Program | null = null;
  private checker: ts.TypeChecker | null = null;
  private diagnostics: DiagnosticsCollector | null = null;
  private readonly options: ReactAnalyzerOptions;

  constructor(options: ReactAnalyzerOptions = {}) {
    this.options = options;
  }

  setDiagnostics(diagnostics: DiagnosticsCollector): void {
    this.diagnostics = diagnostics;
  }

  setProgram(program: ts.Program): void {
    this.program = program;
    this.checker = program.getTypeChecker();
  }

  analyzeFile(filePath: string): ReactFileAnalysis {
    if (!this.program || !this.checker) {
      throw new Error("ReactAstAnalyzer.analyzeFile requires setProgram() to be called first");
    }
    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) {
      this.pushDiagnostic("warn", "react-file-not-in-program", filePath, `Source file not in ts.Program: ${filePath}`);
      return {
        analysis: emptyFileAnalysis(filePath),
        slots: new Map(),
        deprecations: new Map(),
      };
    }
    return this.analyzeSourceFile(sourceFile);
  }

  analyzeSourceFile(sourceFile: ts.SourceFile): ReactFileAnalysis {
    const checker = this.checker;
    if (!checker) {
      throw new Error("ReactAstAnalyzer.analyzeSourceFile requires setProgram() to be called first");
    }

    const components: ComponentAnalysis[] = [];
    const exportedTypes: ExportedType[] = [];
    const slots = new Map<string, ContentSlotInfo[]>();
    const deprecations = new Map<string, DeprecationInfo>();

    for (const statement of sourceFile.statements) {
      // Exported interfaces / type aliases / enums → exportedTypes (for detail_level=types).
      if (isExported(statement)) {
        const exported = extractExportedType(statement, checker);
        if (exported) exportedTypes.push(exported);
      }

      const candidates = this.detectComponents(statement, sourceFile);
      for (const candidate of candidates) {
        try {
          const analysis = this.buildComponentAnalysis(candidate, sourceFile);
          components.push(analysis.component);
          if (analysis.slots.length > 0) slots.set(candidate.name, analysis.slots);
          if (analysis.deprecation) deprecations.set(candidate.name, analysis.deprecation);
        } catch (err) {
          this.pushDiagnostic(
            "warn",
            "react-component-analysis-failed",
            sourceFile.fileName,
            `Failed to analyze component '${candidate.name}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return {
      analysis: {
        filePath: asFilePath(sourceFile.fileName),
        components,
        directives: [],
        pipes: [],
        services: [],
        exportedTypes,
        exportedFunctions: [],
      },
      slots,
      deprecations,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Component detection
  // ──────────────────────────────────────────────────────────────────────

  private detectComponents(statement: ts.Statement, sourceFile: ts.SourceFile): ComponentCandidate[] {
    if (!isExported(statement)) return [];

    // export function Button(props: Props) { return <button/> }
    // Real-world libraries (Base UI et al.) often render through helpers
    // (`return useRenderElement(...)`) with no JSX literal in the body — the
    // checker-based return-type fallback catches those.
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.getText(sourceFile);
      if (
        isComponentName(name) &&
        (containsJsx(statement) || returnsJsxType(statement) || this.returnsJsxPerChecker(statement))
      ) {
        return [{ name, fn: statement, propsTypeNode: null, jsDocHost: statement, kind: "function" }];
      }
      return [];
    }

    // export const Button = ... (arrow, function expression, FC annotation, memo/forwardRef)
    if (ts.isVariableStatement(statement)) {
      const found: ComponentCandidate[] = [];
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.getText(sourceFile);
        if (!isComponentName(name)) continue;

        const fcTypeArg = getFcPropsTypeNode(decl.type);
        const unwrapped = decl.initializer ? unwrapComponentExpression(decl.initializer) : null;

        // An exported PascalCase const wrapped in forwardRef()/memo() is a
        // component regardless of whether the render body contains literal
        // JSX — the wrapper itself is the signal.
        if (
          unwrapped &&
          (unwrapped.wrappers.length > 0 ||
            containsJsx(unwrapped.fn) ||
            returnsJsxType(unwrapped.fn) ||
            fcTypeArg ||
            this.returnsJsxPerChecker(unwrapped.fn))
        ) {
          found.push({
            name,
            fn: unwrapped.fn,
            propsTypeNode: fcTypeArg,
            jsDocHost: statement,
            kind: unwrapped.wrappers.length > 0 ? "wrapped" : "function",
          });
        } else if (!unwrapped && fcTypeArg) {
          // Annotated FC with a non-function initializer we can't see through —
          // still a component; props come from the annotation.
          found.push({ name, fn: null, propsTypeNode: fcTypeArg, jsDocHost: statement, kind: "function" });
        }
      }
      return found;
    }

    // export class Button extends React.Component<Props> { ... }
    if (ts.isClassDeclaration(statement) && statement.name) {
      const name = statement.name.getText(sourceFile);
      if (!isComponentName(name)) return [];
      const propsTypeNode = getClassComponentPropsTypeNode(statement);
      if (propsTypeNode !== undefined) {
        return [{ name, fn: null, propsTypeNode, jsDocHost: statement, kind: "class" }];
      }
      return [];
    }

    return [];
  }

  // ──────────────────────────────────────────────────────────────────────
  // Component analysis
  // ──────────────────────────────────────────────────────────────────────

  private buildComponentAnalysis(
    candidate: ComponentCandidate,
    sourceFile: ts.SourceFile,
  ): { component: ComponentAnalysis; slots: ContentSlotInfo[]; deprecation?: DeprecationInfo } {
    const checker = this.checker;
    if (!checker) throw new Error("checker unavailable");

    const propsType = this.resolvePropsType(candidate);
    const defaults = candidate.fn ? extractDestructuredDefaults(candidate.fn, sourceFile) : new Map<string, string>();

    const inputs: InputProperty[] = [];
    const outputs: OutputProperty[] = [];
    const slots: ContentSlotInfo[] = [];

    if (propsType) {
      for (const prop of propsType.getProperties()) {
        const name = prop.getName();
        if (IGNORED_PROPS.has(name)) continue;

        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        if (!this.options.includeDomProps && decl && isAmbientReactDeclaration(decl)) continue;

        const location = decl ?? candidate.jsDocHost;
        const rawType = checker.getTypeOfSymbolAtLocation(prop, location);
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        const displayType = optional ? checker.getNonNullableType(rawType) : rawType;
        const typeText = checker.typeToString(displayType, undefined, ts.TypeFormatFlags.NoTruncation);
        const description = ts.displayPartsToString(prop.getDocumentationComment(checker)) || undefined;

        // children → content slot, never an input.
        if (name === "children") {
          slots.push({ name: "children", required: !optional, multiple: true });
          continue;
        }

        // Callback props → outputs.
        if (CALLBACK_NAME.test(name) && displayType.getCallSignatures().length > 0) {
          outputs.push({
            name,
            eventType: callbackEventType(displayType, checker),
            eventTypeResolved: true,
            description,
          });
          continue;
        }

        // Named ReactNode props are BOTH a slot (semantics) and an input
        // (the JSX author binds them like any other prop).
        if (SLOT_TYPE.test(typeText)) {
          slots.push({ name, required: !optional && !defaults.has(name), multiple: false });
        }

        const resolvedValues = resolveLiteralUnion(displayType);
        const defaultValue = defaults.get(name);
        const required = !optional && defaultValue === undefined;
        const base = {
          name,
          type: typeText || null,
          typeResolved: typeText.length > 0 && typeText !== "any",
          description,
          resolvedValues,
        };
        inputs.push(required ? { ...base, required: true } : { ...base, required: false, defaultValue });
      }
    } else if (candidate.propsTypeNode !== null || (candidate.fn && candidate.fn.parameters.length > 0)) {
      // The component visibly takes props but we couldn't resolve the type.
      this.pushDiagnostic(
        "warn",
        "react-props-unresolved",
        sourceFile.fileName,
        `Could not resolve props type for component '${candidate.name}'.`,
      );
    }

    const jsDoc = getJsDocInfo(candidate.jsDocHost);

    return {
      component: {
        className: asClassName(candidate.name),
        filePath: asFilePath(sourceFile.fileName),
        metadata: { selector: asSelector(candidate.name), standalone: true },
        inputs,
        outputs,
        publicMethods: [],
        dependencies: [],
        lifecycleHooks: [],
        exportedTypes: [],
        jsDocDescription: jsDoc.description,
      },
      slots,
      deprecation: jsDoc.deprecation,
    };
  }

  /**
   * Checker-based detection fallback: the function's inferred return type
   * names a JSX-ish type (`ReactElement`, `ReactNode`, `JSX.Element`, …).
   * Catches components that render exclusively through helpers and therefore
   * contain no JSX literal. Degrades to `false` when the checker cannot
   * resolve the return type (e.g. React types not installed).
   */
  private returnsJsxPerChecker(fn: ts.SignatureDeclaration): boolean {
    const checker = this.checker;
    if (!checker) return false;
    try {
      const signature = checker.getSignatureFromDeclaration(fn);
      if (!signature) return false;
      const returnText = checker.typeToString(signature.getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation);
      // `React.JSX.Element` prints as bare `Element`; the \b guards keep
      // `HTMLElement`/`SVGElement` (no word boundary before "Element") out.
      return /\b(?:ReactElement|ReactNode|ReactPortal|JSX\.Element|Element)\b/.test(returnText);
    } catch {
      return false;
    }
  }

  private resolvePropsType(candidate: ComponentCandidate): ts.Type | null {
    const checker = this.checker;
    if (!checker) return null;

    // Explicit type node wins: React.FC<P> annotation or class Component<P>.
    if (candidate.propsTypeNode) {
      return checker.getTypeFromTypeNode(candidate.propsTypeNode);
    }

    // First function parameter (also covers forwardRef's (props, ref)).
    const param = candidate.fn?.parameters[0];
    if (!param) return null;
    return checker.getTypeAtLocation(param);
  }

  private pushDiagnostic(severity: "error" | "warn", code: string, file: string, message: string): void {
    this.diagnostics?.push({ severity, code, file, message });
  }
}

// ============================================================================
// Detection helpers
// ============================================================================

interface ComponentCandidate {
  name: string;
  /** The render function, when one is syntactically reachable. */
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | null;
  /** Explicit props type node (FC<P> annotation / class Component<P>). */
  propsTypeNode: ts.TypeNode | null;
  /** Node carrying the component's JSDoc (statement level for consts). */
  jsDocHost: ts.Node;
  kind: "function" | "wrapped" | "class";
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
    return true;
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found && containsJsx(child)) found = true;
  });
  return found;
}

function returnsJsxType(fn: ts.SignatureDeclaration): boolean {
  const typeText = fn.type?.getText();
  return !!typeText && SLOT_TYPE.test(typeText);
}

/**
 * Unwrap call wrappers down to the inner arrow/function expression:
 * `memo(...)`, `forwardRef(...)`, `React.memo(React.forwardRef(...))`, and
 * ANY custom factory whose first argument is a function (e.g. Base UI's
 * `fastComponent(function TooltipRoot(...) {...})`).
 *
 * Only `memo`/`forwardRef` are recorded in `wrappers` (a component signal by
 * themselves); unknown factories merely unwrap — the inner function must
 * still prove itself via JSX / return type / FC annotation. Returns null
 * when no function is syntactically reachable (e.g. `memo(SomeIdentifier)`).
 */
function unwrapComponentExpression(
  expr: ts.Expression,
): { fn: ts.ArrowFunction | ts.FunctionExpression; wrappers: string[] } | null {
  const wrappers: string[] = [];
  let current: ts.Expression = expr;

  for (let depth = 0; depth < 5; depth++) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return { fn: current, wrappers };
    }
    if (ts.isCallExpression(current)) {
      const calleeText = current.expression.getText();
      const callee = calleeText.split(".").pop() ?? calleeText;
      const firstArg = current.arguments[0];
      if (callee === "memo" || callee === "forwardRef") {
        if (firstArg === undefined) return null;
        wrappers.push(callee);
        current = firstArg;
        continue;
      }
      // Unknown factory — descend only when the first argument is visibly a
      // function; the wrapper itself proves nothing.
      if (firstArg !== undefined && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))) {
        current = firstArg;
        continue;
      }
      return null;
    }
    return null;
  }
  return null;
}

/** `React.FC<P>` / `FC<P>` / `FunctionComponent<P>` / `ForwardRefExoticComponent<P>` annotation → P. */
function getFcPropsTypeNode(typeNode: ts.TypeNode | undefined): ts.TypeNode | null {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
  const nameText = typeNode.typeName.getText();
  const bare = nameText.split(".").pop() ?? nameText;
  if (!["FC", "FunctionComponent", "VFC", "VoidFunctionComponent", "ForwardRefExoticComponent"].includes(bare)) {
    return null;
  }
  return typeNode.typeArguments?.[0] ?? null;
}

/**
 * Class component: `extends React.Component<P>` / `extends PureComponent<P>`.
 * Returns the P type node, `null` when the class IS a component but has no
 * props generic, or `undefined` when the class is not a React component.
 */
function getClassComponentPropsTypeNode(cls: ts.ClassDeclaration): ts.TypeNode | null | undefined {
  for (const heritage of cls.heritageClauses ?? []) {
    if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of heritage.types) {
      const text = type.expression.getText();
      const bare = text.split(".").pop() ?? text;
      if (bare === "Component" || bare === "PureComponent") {
        return type.typeArguments?.[0] ?? null;
      }
    }
  }
  return undefined;
}

// ============================================================================
// Prop extraction helpers
// ============================================================================

/** Declarations living in React's ambient types or the TS default lib. */
function isAmbientReactDeclaration(decl: ts.Declaration): boolean {
  const fileName = decl.getSourceFile().fileName;
  return (
    fileName.includes("node_modules/@types/react") ||
    fileName.includes("node_modules/react/") ||
    fileName.includes("typescript/lib/")
  );
}

/** `({ variant = "primary", size = 2 }: Props)` → Map { variant → '"primary"', size → '2' }. */
function extractDestructuredDefaults(fn: ts.SignatureDeclaration, sourceFile: ts.SourceFile): Map<string, string> {
  const defaults = new Map<string, string>();
  const param = fn.parameters[0];
  if (!param || !ts.isObjectBindingPattern(param.name)) return defaults;

  for (const element of param.name.elements) {
    if (!element.initializer) continue;
    const propName = (element.propertyName ?? element.name).getText(sourceFile);
    defaults.set(propName, element.initializer.getText(sourceFile));
  }
  return defaults;
}

/** First call signature's first parameter type, or "void" for zero-arg callbacks. */
function callbackEventType(type: ts.Type, checker: ts.TypeChecker): string {
  const signature = type.getCallSignatures()[0];
  if (!signature) return "void";
  const params = signature.getParameters();
  if (params.length === 0) return "void";
  const decl = params[0].valueDeclaration ?? params[0].declarations?.[0];
  if (!decl) return "void";
  return checker.typeToString(checker.getTypeAtLocation(decl), undefined, ts.TypeFormatFlags.NoTruncation);
}

/** String/number literal unions → ResolvedValues; mixed unions are partial. */
function resolveLiteralUnion(type: ts.Type): ResolvedValues | null {
  if (!type.isUnion()) return null;

  const values: string[] = [];
  let partial = false;
  for (const member of type.types) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
    if (member.isStringLiteral()) {
      values.push(member.value);
    } else if (member.isNumberLiteral()) {
      values.push(String(member.value));
    } else {
      partial = true;
    }
  }
  if (values.length === 0) return null;
  return { values, partial };
}

// ============================================================================
// JSDoc / deprecation
// ============================================================================

const SINCE_RE = /since\s+v?(\d+\.\d+\.\d+)/i;
const REMOVE_IN_RE = /(?:removed?\s+in|remove\s+(?:in|at))\s+v?(\d+\.\d+\.\d+)/i;
const REPLACEMENT_RE = /(?:use|replaced?\s+(?:by|with))\s+(\S+)\s+instead/i;

function getJsDocInfo(node: ts.Node): { description?: string; deprecation?: DeprecationInfo } {
  let description: string | undefined;
  let deprecation: DeprecationInfo | undefined;

  for (const docOrTag of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(docOrTag)) {
      const comment = commentText(docOrTag.comment);
      if (comment && !description) description = comment;
      for (const tag of docOrTag.tags ?? []) {
        if (tag.tagName.getText() === "deprecated") {
          deprecation = parseDeprecationText(commentText(tag.comment) ?? "");
        }
      }
    } else if (docOrTag.tagName.getText() === "deprecated") {
      deprecation = parseDeprecationText(commentText(docOrTag.comment) ?? "");
    }
  }

  return { description, deprecation };
}

function commentText(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string | undefined {
  if (comment === undefined) return undefined;
  if (typeof comment === "string") return comment.trim() || undefined;
  return (
    comment
      .map((c) => c.getText())
      .join("")
      .trim() || undefined
  );
}

/** Same regex heuristics as the Angular deprecation extractor (§4.7). */
export function parseDeprecationText(raw: string): DeprecationInfo {
  const info: DeprecationInfo = { deprecated: true, reason: raw };
  const since = raw.match(SINCE_RE);
  if (since) info.since = since[1];
  const removeIn = raw.match(REMOVE_IN_RE);
  if (removeIn) info.removeIn = removeIn[1];
  const replacement = raw.match(REPLACEMENT_RE);
  if (replacement) info.replacement = replacement[1].replace(/[.,;]$/, "");
  return info;
}

// ============================================================================
// Exported types
// ============================================================================

function extractExportedType(statement: ts.Statement, checker: ts.TypeChecker): ExportedType | null {
  if (ts.isInterfaceDeclaration(statement)) {
    const members: TypeMember[] = [];
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const typeText = member.type?.getText() ?? null;
      members.push({
        name: member.name.getText(),
        type: typeText,
        typeResolved: typeText !== null,
        optional: !!member.questionToken,
        description: jsDocOf(member, checker),
      });
    }
    return { name: statement.name.getText(), kind: "interface", definition: statement.getText(), members };
  }
  if (ts.isTypeAliasDeclaration(statement)) {
    return { name: statement.name.getText(), kind: "type", definition: statement.getText() };
  }
  if (ts.isEnumDeclaration(statement)) {
    return {
      name: statement.name.getText(),
      kind: "enum",
      definition: statement.getText(),
      members: statement.members.map((m) => ({
        name: m.name.getText(),
        value: m.initializer?.getText(),
      })),
    };
  }
  return null;
}

function jsDocOf(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  void checker;
  for (const docOrTag of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(docOrTag)) {
      const text = commentText(docOrTag.comment);
      if (text) return text;
    }
  }
  return undefined;
}

// ============================================================================
// Misc
// ============================================================================

function emptyFileAnalysis(filePath: string): FileAnalysis {
  return {
    filePath: asFilePath(filePath),
    components: [],
    directives: [],
    pipes: [],
    services: [],
    exportedTypes: [],
    exportedFunctions: [],
  };
}
