/**
 * AST-based Angular Component Analyzer
 * Uses TypeScript Compiler API for accurate code analysis
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { DiagnosticsCollector } from "../../shared/diagnostics.js";
import { SourceFileCache } from "../../shared/source-file-cache.js";
import { TemplateParseCache, walkTemplate } from "../../shared/template-parser.js";
import {
  evaluateExpression,
  extractJsDocComment,
  extractTypeArgFromTypeNode,
  getDecoratorName,
  hasExportModifier,
} from "../../shared/ts-util.js";
import type {
  ClassName,
  ComponentAnalysis,
  ComponentMetadata,
  ComponentMetadataBase,
  ExportedFunction,
  ExportedType,
  FileAnalysis,
  FilePath,
  InjectedDependency,
  InputProperty,
  LifecycleHook,
  MethodParameter,
  Mutable,
  OutputProperty,
  PipeAnalysis,
  PublicMethod,
  Selector,
  ServiceAnalysis,
  TypeMember,
} from "../../types.js";
import { asClassName, asFilePath, asSelector } from "../../types.js";

// ============================================================================
// resolveUnionLiterals discriminated result
// ============================================================================

/**
 * Discriminated result for `AngularAstAnalyzer.resolveUnionLiterals`.
 *
 * - `ok`        — the type checker resolved the union; `values` is non-empty.
 *                 `partial: true` indicates non-literal members were dropped
 *                 (e.g. `'a' | 'b' | SomeAlias`). On disk this is still emitted
 *                 as `string[] | undefined` (Phase 4 will add `partial`).
 * - `no-checker` — `setTypeChecker(...)` was never called. The CLI always sets
 *                  one, so this normally only happens in tests.
 * - `not-in-program` — the source file driving the type node is not part of the
 *                      currently-set program.
 * - `not-union` — the type checker resolved the type, but it was not a literal
 *                 union (e.g. `string`, `number`, `unknown`, etc.).
 */
export type ResolveUnionResult =
  | { kind: "ok"; values: string[]; partial: boolean }
  | { kind: "no-checker" }
  | { kind: "not-in-program" }
  | { kind: "not-union" };

export { SourceFileCache };

// Re-export types for consumers
export type {
  ComponentMetadata,
  InputProperty,
  OutputProperty,
  PublicMethod,
  MethodParameter,
  InjectedDependency,
  ExportedType,
  TypeMember,
  LifecycleHook,
  ComponentAnalysis,
  FileAnalysis,
  PipeAnalysis,
  ServiceAnalysis,
  ExportedFunction,
};

// ============================================================================
// Module-level constant Sets (hot-path lookups; built once per process)
// ============================================================================

const lifecycleHooks: ReadonlySet<string> = new Set([
  "ngOnInit",
  "ngOnDestroy",
  "ngOnChanges",
  "ngDoCheck",
  "ngAfterContentInit",
  "ngAfterContentChecked",
  "ngAfterViewInit",
  "ngAfterViewChecked",
]);

// ============================================================================
// AST Analyzer Class
// ============================================================================

export class AngularAstAnalyzer {
  private checker: ts.TypeChecker | null = null;
  private program: ts.Program | null = null;
  private diagnostics: DiagnosticsCollector | null = null;
  private currentClassName: string | undefined;

  /**
   * Set a TypeChecker for resolving literal union type values.
   * When set, input properties will include resolvedValues for string/number literal unions.
   */
  setTypeChecker(program: ts.Program): void {
    this.program = program;
    this.checker = program.getTypeChecker();
  }

  /**
   * Optional diagnostics collector. When set, non-`ok` outcomes from
   * `resolveUnionLiterals` are reported as `severity: 'warn'` with code
   * `union-resolution-<kind>`. Safe to leave unset (analyzer used outside the CLI).
   */
  setDiagnostics(collector: DiagnosticsCollector): void {
    this.diagnostics = collector;
  }

  /**
   * Analyze a single TypeScript file.
   *
   * Prefers a SourceFile from the configured `ts.Program` (so the type checker
   * can resolve literal unions on the same AST nodes we extract). Falls back to
   * a fresh `ts.createSourceFile` parse when no program is set or the file is
   * not part of it.
   */
  analyzeFile(filePath: string): FileAnalysis {
    const sourceFile =
      this.program?.getSourceFile(filePath) ??
      ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf-8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const analysis: Mutable<FileAnalysis> = {
      filePath: asFilePath(filePath),
      components: [],
      directives: [],
      pipes: [],
      services: [],
      exportedTypes: [],
      exportedFunctions: [],
    };

    this.visitNode(sourceFile, analysis, sourceFile);
    return analysis;
  }

  /**
   * Recursively visit AST nodes
   */
  private visitNode(node: ts.Node, analysis: Mutable<FileAnalysis>, sourceFile: ts.SourceFile): void {
    if (ts.isClassDeclaration(node)) {
      this.analyzeClass(node, analysis, sourceFile);
    } else if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
      analysis.exportedTypes.push(this.analyzeInterface(node, sourceFile));
    } else if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
      analysis.exportedTypes.push(this.analyzeTypeAlias(node, sourceFile));
    } else if (ts.isEnumDeclaration(node) && hasExportModifier(node)) {
      analysis.exportedTypes.push(this.analyzeEnum(node, sourceFile));
    } else if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const fn = this.analyzeFunction(node, sourceFile);
      if (fn) analysis.exportedFunctions.push(fn);
    }

    ts.forEachChild(node, (child) => this.visitNode(child, analysis, sourceFile));
  }

  /**
   * Analyze a class declaration (Component, Directive, Pipe, Service)
   */
  private analyzeClass(node: ts.ClassDeclaration, analysis: Mutable<FileAnalysis>, sourceFile: ts.SourceFile): void {
    const decorators = ts.getDecorators(node);
    if (!decorators) return;

    for (const decorator of decorators) {
      const decoratorName = getDecoratorName(decorator);

      if (decoratorName === "Component" || decoratorName === "Directive") {
        const componentAnalysis = this.analyzeComponentOrDirective(node, decorator, sourceFile);
        if (!componentAnalysis) continue; // anonymous class — skipped + diagnostic
        if (decoratorName === "Component") {
          analysis.components.push(componentAnalysis);
        } else {
          analysis.directives.push(componentAnalysis);
        }
        // Empty-selector diagnostic (v4.0): keep the entry but warn — selectorMap
        // will exclude it. This applies to components only; directives can be
        // attribute selectors that look empty after `[...]`-stripping but still
        // carry text in metadata.selector.
        if (decoratorName === "Component" && !componentAnalysis.metadata.selector) {
          this.diagnostics?.push({
            severity: "warn",
            code: "empty-selector",
            component: componentAnalysis.className,
            file: sourceFile.fileName,
            message: `Component ${componentAnalysis.className} has no selector; it will not appear in selectorMap.`,
          });
        }
      } else if (decoratorName === "Pipe") {
        const pipe = this.analyzePipe(node, decorator, sourceFile);
        if (pipe) analysis.pipes.push(pipe);
      } else if (decoratorName === "Injectable") {
        const service = this.analyzeService(node, decorator, sourceFile);
        if (service) analysis.services.push(service);
      }
    }
  }

  /**
   * Analyze @Component or @Directive decorated class.
   * Returns `undefined` for anonymous classes (v4.0: no more `UnnamedComponent`
   * sentinel emitted; instead a diagnostic is pushed and the entry skipped).
   */
  private analyzeComponentOrDirective(
    node: ts.ClassDeclaration,
    decorator: ts.Decorator,
    sourceFile: ts.SourceFile,
  ): ComponentAnalysis | undefined {
    const className = node.name?.getText(sourceFile);
    if (!className) {
      this.diagnostics?.push({
        severity: "warn",
        code: "anonymous-class-skipped",
        file: sourceFile.fileName,
        message: "Anonymous @Component/@Directive class skipped; cannot emit a component entry without a class name.",
      });
      return undefined;
    }
    this.currentClassName = className;
    const metadata = this.extractDecoratorMetadata(decorator, sourceFile);

    const inputs: InputProperty[] = [];
    const outputs: OutputProperty[] = [];
    const publicMethods: PublicMethod[] = [];
    const dependencies: InjectedDependency[] = [];
    const lifecycleHooks: LifecycleHook[] = [];

    // Analyze class members
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        const inputProp = this.extractInputProperty(member, sourceFile);
        if (inputProp) inputs.push(inputProp);

        const outputProp = this.extractOutputProperty(member, sourceFile);
        if (outputProp) outputs.push(outputProp);
      } else if (ts.isGetAccessor(member)) {
        // Handle @Input() get property(): Type { } (decorator on getter)
        const inputProp = this.extractInputFromGetter(member, node, sourceFile);
        if (inputProp) inputs.push(inputProp);
      } else if (ts.isSetAccessor(member)) {
        // Handle @Input() set property(value: Type) { } (decorator on setter)
        const inputProp = this.extractInputFromSetter(member, sourceFile);
        if (inputProp) inputs.push(inputProp);
      } else if (ts.isMethodDeclaration(member)) {
        // Check if method has @Input() decorator (Angular supports @Input on methods)
        const methodInputProp = this.extractInputFromMethod(member, sourceFile);
        if (methodInputProp) {
          inputs.push(methodInputProp);
        }

        const method = this.analyzeMethod(member, sourceFile);

        // Check if it's a lifecycle hook
        if (this.isLifecycleHook(method.name)) {
          lifecycleHooks.push({ name: method.name, implemented: true });
        } else if (this.isPublicMember(member)) {
          publicMethods.push(method);
        }
      } else if (ts.isConstructorDeclaration(member)) {
        dependencies.push(...this.extractConstructorDependencies(member, sourceFile));
      }
    }

    // Check for signal-based inputs/outputs (Angular 17+)
    inputs.push(...this.extractSignalInputs(node, sourceFile));
    outputs.push(...this.extractSignalOutputs(node, sourceFile));

    // Dedup inputs by name (bug C1): @Input() on both get/set produces two entries.
    // Keep the first, but prefer an entry whose type was successfully resolved
    // when an earlier entry's type is null (typeResolved=false). Type extracted
    // from the getter return type or setter parameter — either is equally valid.
    const dedupedInputs: InputProperty[] = [];
    const inputsByName = new Map<string, number>();
    for (const inp of inputs) {
      const prev = inputsByName.get(inp.name);
      if (prev === undefined) {
        inputsByName.set(inp.name, dedupedInputs.length);
        dedupedInputs.push(inp);
      } else if (!dedupedInputs[prev].typeResolved && inp.typeResolved) {
        dedupedInputs[prev] = inp;
      }
    }

    return {
      className: asClassName(className),
      filePath: asFilePath(sourceFile.fileName),
      metadata: this.buildComponentMetadata(metadata),
      inputs: dedupedInputs,
      outputs,
      publicMethods,
      dependencies,
      lifecycleHooks,
      exportedTypes: [],
      jsDocDescription: extractJsDocComment(node),
    };
  }

  /**
   * Extract @Input() property information
   *
   * Note: Only mark inputs as required if they have explicit `required: true` in decorator.
   * Many Angular components set defaults in constructors (from config tokens), which
   * we can't detect via static analysis.
   */
  private extractInputProperty(node: ts.PropertyDeclaration, sourceFile: ts.SourceFile): InputProperty | null {
    const decorators = ts.getDecorators(node);
    if (!decorators) return null;

    const inputDecorator = decorators.find((d) => getDecoratorName(d) === "Input");
    if (!inputDecorator) return null;

    const name = node.name.getText(sourceFile);
    const explicitType = node.type?.getText(sourceFile);
    const inferred = explicitType === undefined ? this.inferType(node) : explicitType;
    const type = inferred ?? null;
    const typeResolved = type !== null;
    const defaultValue = node.initializer?.getText(sourceFile);
    const decoratorArgs = this.getDecoratorArguments(inputDecorator, sourceFile);

    // Only mark as required if explicitly set in decorator options
    // (like @Input({ required: true })) - common Angular pattern
    // sets defaults in constructor which we can't detect
    const hasExplicitRequired = decoratorArgs.required !== undefined;
    const isRequired = hasExplicitRequired ? this.asBoolean(decoratorArgs.required, false) : false;

    const common = {
      name,
      type,
      typeResolved,
      alias: this.asString(decoratorArgs.alias),
      transform: this.asString(decoratorArgs.transform),
      description: extractJsDocComment(node),
      resolvedValues: this.resolveUnionLiteralValues(node.type, sourceFile),
    };

    // XOR: required:true omits defaultValue entirely.
    if (isRequired) {
      return { ...common, required: true };
    }
    return { ...common, required: false, defaultValue };
  }

  /**
   * Extract @Input() from setter method
   */
  private extractInputFromSetter(node: ts.SetAccessorDeclaration, sourceFile: ts.SourceFile): InputProperty | null {
    const decorators = ts.getDecorators(node);
    if (!decorators) return null;

    const inputDecorator = decorators.find((d) => getDecoratorName(d) === "Input");
    if (!inputDecorator) return null;

    const name = node.name.getText(sourceFile);
    const param = node.parameters[0];
    const rawType = param?.type?.getText(sourceFile);
    const type = rawType ?? null;
    const typeResolved = type !== null;
    const decoratorArgs = this.getDecoratorArguments(inputDecorator, sourceFile);

    // Only mark as required if explicitly set in decorator
    const hasExplicitRequired = decoratorArgs.required !== undefined;
    const isRequired = hasExplicitRequired ? this.asBoolean(decoratorArgs.required, false) : false;

    const common = {
      name,
      type,
      typeResolved,
      alias: this.asString(decoratorArgs.alias),
      transform: this.asString(decoratorArgs.transform),
      description: extractJsDocComment(node),
      resolvedValues: this.resolveUnionLiteralValues(param?.type, sourceFile),
    };
    if (isRequired) return { ...common, required: true };
    return { ...common, required: false };
  }

  /**
   * Extract @Input() from getter method (when decorator is on the getter, not setter)
   * Common pattern: @Input() get prop(): Type { } set prop(value: Type) { }
   */
  private extractInputFromGetter(
    node: ts.GetAccessorDeclaration,
    classNode: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
  ): InputProperty | null {
    const decorators = ts.getDecorators(node);
    if (!decorators) return null;

    const inputDecorator = decorators.find((d) => getDecoratorName(d) === "Input");
    if (!inputDecorator) return null;

    const name = node.name.getText(sourceFile);

    // Get type from getter's return type
    let type: string | null = node.type?.getText(sourceFile) ?? null;
    let resolvedTypeNode: ts.TypeNode | undefined = node.type;

    // If no return type on getter, try to find matching setter for the type
    if (type === null) {
      for (const member of classNode.members) {
        if (ts.isSetAccessor(member) && member.name.getText(sourceFile) === name) {
          const param = member.parameters[0];
          type = param?.type?.getText(sourceFile) ?? null;
          resolvedTypeNode = param?.type;
          break;
        }
      }
    }

    const decoratorArgs = this.getDecoratorArguments(inputDecorator, sourceFile);

    return {
      name,
      type,
      typeResolved: type !== null,
      required: false, // Getter/setter pairs typically have internal defaults
      alias: this.asString(decoratorArgs.alias),
      transform: this.asString(decoratorArgs.transform),
      description: extractJsDocComment(node),
      resolvedValues: this.resolveUnionLiteralValues(resolvedTypeNode, sourceFile),
    } satisfies InputProperty;
  }

  /**
   * Extract @Input() from method declaration.
   * Angular allows @Input() on methods for function-value inputs.
   * e.g. @Input() canDrop(source: Node, target?: Node): boolean { ... }
   */
  private extractInputFromMethod(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): InputProperty | null {
    const decorators = ts.getDecorators(node);
    if (!decorators) return null;

    const inputDecorator = decorators.find((d) => getDecoratorName(d) === "Input");
    if (!inputDecorator) return null;

    const name = node.name.getText(sourceFile);
    const params = node.parameters.map((p) => this.analyzeParameter(p, sourceFile));
    // Method return type: explicit annotation = resolved (e.g. ': void' is fine).
    // Missing annotation -> typeResolved=false on the synthesized function type.
    const explicitReturn = node.type?.getText(sourceFile);
    const returnTypeResolved = explicitReturn !== undefined;
    const paramSignature = params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type ?? "unknown"}`).join(", ");
    const type = `(${paramSignature}) => ${explicitReturn ?? "unknown"}`;
    const allParamsResolved = params.every((p) => p.typeResolved);
    const typeResolved = returnTypeResolved && allParamsResolved;

    const decoratorArgs = this.getDecoratorArguments(inputDecorator, sourceFile);
    const hasExplicitRequired = decoratorArgs.required !== undefined;
    const isRequired = hasExplicitRequired ? this.asBoolean(decoratorArgs.required, false) : false;

    const common = {
      name,
      type,
      typeResolved,
      alias: this.asString(decoratorArgs.alias),
      transform: this.asString(decoratorArgs.transform),
      description: extractJsDocComment(node),
      resolvedValues: null,
    };
    if (isRequired) return { ...common, required: true };
    return { ...common, required: false };
  }

  /**
   * Extract @Output() property information
   */
  private extractOutputProperty(node: ts.PropertyDeclaration, sourceFile: ts.SourceFile): OutputProperty | null {
    const decorators = ts.getDecorators(node);
    if (!decorators) return null;

    const outputDecorator = decorators.find((d) => getDecoratorName(d) === "Output");
    if (!outputDecorator) return null;

    const name = node.name.getText(sourceFile);
    const eventType = node.type ? (extractTypeArgFromTypeNode(node.type, "")?.getText(sourceFile) ?? null) : null;

    const decoratorArgs = this.getDecoratorArguments(outputDecorator, sourceFile);

    return {
      name,
      eventType,
      eventTypeResolved: eventType !== null,
      alias: this.asString(decoratorArgs.alias),
      description: extractJsDocComment(node),
    };
  }

  /**
   * Extract signal-based inputs (Angular 17+): input(), input.required()
   */
  private extractSignalInputs(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): InputProperty[] {
    const inputs: InputProperty[] = [];

    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;

      const initializer = member.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;

      const { isSignalInput, isRequired } = this.detectSignalInput(initializer, sourceFile);
      if (!isSignalInput) continue;

      const name = member.name.getText(sourceFile);
      const type = this.extractTypeArgFromCallExpression(initializer, sourceFile);

      // Resolve literal union values from the type argument (e.g. input<ButtonVariant>())
      const typeArgNode = initializer.typeArguments?.[0];
      const resolvedValues = this.resolveUnionLiteralValues(typeArgNode, sourceFile);

      const common = {
        name,
        type,
        typeResolved: type !== null,
        description: extractJsDocComment(member),
        resolvedValues,
      };
      inputs.push(isRequired ? { ...common, required: true } : { ...common, required: false });
    }

    return inputs;
  }

  /**
   * Detect if a call expression is input() or input.required()
   */
  private detectSignalInput(
    call: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): { isSignalInput: boolean; isRequired: boolean } {
    const expr = call.expression;

    // input()
    if (ts.isIdentifier(expr) && expr.getText(sourceFile) === "input") {
      return { isSignalInput: true, isRequired: false };
    }

    // input.required()
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.getText(sourceFile) === "input" &&
      expr.name.getText(sourceFile) === "required"
    ) {
      return { isSignalInput: true, isRequired: true };
    }

    return { isSignalInput: false, isRequired: false };
  }

  /**
   * Extract signal-based outputs (Angular 17+): output()
   */
  private extractSignalOutputs(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): OutputProperty[] {
    const outputs: OutputProperty[] = [];

    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;

      const initializer = member.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;

      // Check if it's output() call
      const expr = initializer.expression;
      const isOutputCall = ts.isIdentifier(expr) && expr.getText(sourceFile) === "output";
      if (!isOutputCall) continue;

      const name = member.name.getText(sourceFile);
      const eventType = this.extractTypeArgFromCallExpression(initializer, sourceFile);

      outputs.push({
        name,
        eventType,
        eventTypeResolved: eventType !== null,
        description: extractJsDocComment(member),
      });
    }

    return outputs;
  }

  /**
   * Extract constructor dependencies
   */
  private extractConstructorDependencies(
    node: ts.ConstructorDeclaration,
    sourceFile: ts.SourceFile,
  ): InjectedDependency[] {
    const dependencies: InjectedDependency[] = [];

    for (const param of node.parameters) {
      // Skip non-injected parameters (no access modifier)
      if (!this.hasAccessModifier(param)) continue;

      const decorators = ts.getDecorators(param);
      const name = param.name.getText(sourceFile);
      const type = param.type?.getText(sourceFile) ?? null;

      const hasSelf = !!decorators?.some((d) => getDecoratorName(d) === "Self");
      const hasSkipSelf = !!decorators?.some((d) => getDecoratorName(d) === "SkipSelf");
      const depBase = {
        name,
        type,
        typeResolved: type !== null,
        optional: !!decorators?.some((d) => getDecoratorName(d) === "Optional"),
        host: !!decorators?.some((d) => getDecoratorName(d) === "Host"),
      };
      // Angular DI: @Self and @SkipSelf are mutually exclusive. When both
      // appear we trust @Self (invalid code in the source, but pick one).
      const dep: InjectedDependency = hasSelf
        ? { ...depBase, self: true, skipSelf: false }
        : { ...depBase, self: false, skipSelf: hasSkipSelf };

      // Check for @Inject() token
      const injectDecorator = decorators?.find((d) => getDecoratorName(d) === "Inject");
      if (injectDecorator && ts.isCallExpression(injectDecorator.expression)) {
        const args = injectDecorator.expression.arguments;
        if (args.length > 0) {
          dep.injectionToken = args[0].getText(sourceFile);
        }
      }

      dependencies.push(dep);
    }

    return dependencies;
  }

  /**
   * Analyze a method declaration
   */
  private analyzeMethod(node: ts.MethodDeclaration, sourceFile: ts.SourceFile): PublicMethod {
    const name = node.name.getText(sourceFile);
    const parameters = node.parameters.map((p) => this.analyzeParameter(p, sourceFile));
    // v4.0: explicit `: void` annotation -> 'void' + resolved=true. Missing
    // annotation -> null + resolved=false (don't lie about implicit-void).
    const returnType = node.type?.getText(sourceFile) ?? null;
    const isAsync = !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

    return {
      name,
      parameters,
      returnType,
      returnTypeResolved: returnType !== null,
      isAsync,
      description: extractJsDocComment(node),
    };
  }

  /**
   * Analyze a function parameter
   */
  private analyzeParameter(node: ts.ParameterDeclaration, sourceFile: ts.SourceFile): MethodParameter {
    const explicit = node.type?.getText(sourceFile);
    const inferred = explicit ?? (node.initializer ? this.extractTypeFromInitializer(node.initializer) : null);
    const type = inferred ?? null;
    return {
      name: node.name.getText(sourceFile),
      type,
      typeResolved: type !== null,
      optional: !!node.questionToken || !!node.initializer,
      defaultValue: node.initializer?.getText(sourceFile),
    };
  }

  /**
   * Analyze @Pipe decorated class
   */
  private analyzePipe(
    node: ts.ClassDeclaration,
    decorator: ts.Decorator,
    sourceFile: ts.SourceFile,
  ): PipeAnalysis | undefined {
    const className = node.name?.getText(sourceFile);
    if (!className) {
      this.diagnostics?.push({
        severity: "warn",
        code: "anonymous-class-skipped",
        file: sourceFile.fileName,
        message: "Anonymous @Pipe class skipped.",
      });
      return undefined;
    }
    const metadata = this.extractDecoratorMetadata(decorator, sourceFile);

    let transformMethod: PublicMethod | undefined;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === "transform") {
        transformMethod = this.analyzeMethod(member, sourceFile);
        break;
      }
    }

    return {
      className: asClassName(className),
      pipeName: this.asString(metadata.name) || "",
      pure: this.asBoolean(metadata.pure, true),
      standalone: this.asBoolean(metadata.standalone, true),
      transformMethod,
    };
  }

  /**
   * Analyze @Injectable decorated class
   */
  private analyzeService(
    node: ts.ClassDeclaration,
    decorator: ts.Decorator,
    sourceFile: ts.SourceFile,
  ): ServiceAnalysis | undefined {
    const className = node.name?.getText(sourceFile);
    if (!className) {
      this.diagnostics?.push({
        severity: "warn",
        code: "anonymous-class-skipped",
        file: sourceFile.fileName,
        message: "Anonymous @Injectable class skipped.",
      });
      return undefined;
    }
    const metadata = this.extractDecoratorMetadata(decorator, sourceFile);

    const dependencies: InjectedDependency[] = [];
    const publicMethods: PublicMethod[] = [];

    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member)) {
        dependencies.push(...this.extractConstructorDependencies(member, sourceFile));
      } else if (ts.isMethodDeclaration(member) && this.isPublicMember(member)) {
        publicMethods.push(this.analyzeMethod(member, sourceFile));
      }
    }

    return {
      className: asClassName(className),
      providedIn: normalizeProvidedIn(this.asString(metadata.providedIn)),
      dependencies,
      publicMethods,
    };
  }

  /**
   * Analyze an interface declaration
   */
  private analyzeInterface(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): ExportedType {
    const name = node.name.getText(sourceFile);
    const members: TypeMember[] = [];

    for (const member of node.members) {
      if (ts.isPropertySignature(member)) {
        const t = member.type?.getText(sourceFile) ?? null;
        members.push({
          name: member.name.getText(sourceFile),
          type: t,
          typeResolved: t !== null,
          optional: !!member.questionToken,
          description: extractJsDocComment(member),
        });
      }
    }

    return {
      name,
      kind: "interface",
      definition: node.getText(sourceFile),
      members,
    };
  }

  /**
   * Analyze a type alias declaration
   */
  private analyzeTypeAlias(node: ts.TypeAliasDeclaration, sourceFile: ts.SourceFile): ExportedType {
    return {
      name: node.name.getText(sourceFile),
      kind: "type",
      definition: node.getText(sourceFile),
    };
  }

  /**
   * Analyze an enum declaration
   */
  private analyzeEnum(node: ts.EnumDeclaration, sourceFile: ts.SourceFile): ExportedType {
    const members: TypeMember[] = node.members.map((member) => ({
      name: member.name.getText(sourceFile),
      type: member.initializer?.getText(sourceFile) || "number",
      typeResolved: true,
      optional: false,
    }));

    return {
      name: node.name.getText(sourceFile),
      kind: "enum",
      definition: node.getText(sourceFile),
      members,
    };
  }

  /**
   * Analyze a function declaration
   */
  private analyzeFunction(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): ExportedFunction | null {
    if (!node.name) return null;

    const returnType = node.type?.getText(sourceFile) ?? null;
    return {
      name: node.name.getText(sourceFile),
      parameters: node.parameters.map((p) => this.analyzeParameter(p, sourceFile)),
      returnType,
      returnTypeResolved: returnType !== null,
      isAsync: !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      description: extractJsDocComment(node),
    };
  }

  // ============================================================================
  // AST Type Extraction Helpers
  // ============================================================================

  /**
   * Extract type argument from a CallExpression's type arguments.
   * e.g. input<string>() -> "string", output<MouseEvent>() -> "MouseEvent"
   */
  private extractTypeArgFromCallExpression(call: ts.CallExpression, sourceFile: ts.SourceFile): string | null {
    if (call.typeArguments && call.typeArguments.length > 0) {
      return call.typeArguments[0].getText(sourceFile);
    }
    return null;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Resolve literal union values for a type node using the TypeChecker.
   *
   * Returns a discriminated result distinguishing the four failure modes from
   * success. Operates on the AST node directly — Phase 2 removed the position-
   * matching hack now that `analyzeFile` reuses the program's SourceFile.
   *
   * If `typeNode` is undefined the caller has nothing to resolve; we report
   * `not-union` (no union type to talk about) without emitting a diagnostic.
   */
  resolveUnionLiterals(typeNode: ts.TypeNode | undefined, sourceFile: ts.SourceFile): ResolveUnionResult {
    if (!typeNode) return { kind: "not-union" };
    if (!this.checker) {
      this.reportUnionFailure("no-checker", sourceFile);
      return { kind: "no-checker" };
    }

    // The node must belong to a SourceFile that's part of the current program,
    // otherwise the type checker can't resolve it. Compare instances rather than
    // file names to catch the standalone-parse case.
    const programSourceFile = this.program?.getSourceFile(sourceFile.fileName);
    if (!programSourceFile || programSourceFile !== sourceFile) {
      this.reportUnionFailure("not-in-program", sourceFile);
      return { kind: "not-in-program" };
    }

    const type = this.checker.getTypeFromTypeNode(typeNode);
    const extracted = extractLiteralValuesDetailed(type);
    if (!extracted) {
      // Don't report 'not-union' as a diagnostic — many type nodes legitimately
      // aren't unions (string, number, custom interfaces, etc.). Reporting them
      // would drown the diagnostics array.
      return { kind: "not-union" };
    }
    return { kind: "ok", values: extracted.values, partial: extracted.partial };
  }

  /**
   * Wire-format wrapper for extractors. Returns `{ values, partial } | null`
   * (schema v4.0 — Phase 2 deferred this). `null` covers all non-`ok`
   * outcomes (no-checker, not-in-program, not-union).
   */
  private resolveUnionLiteralValues(
    typeNode: ts.TypeNode | undefined,
    sourceFile: ts.SourceFile,
  ): { values: string[]; partial: boolean } | null {
    const result = this.resolveUnionLiterals(typeNode, sourceFile);
    return result.kind === "ok" ? { values: result.values, partial: result.partial } : null;
  }

  private reportUnionFailure(kind: "no-checker" | "not-in-program", sourceFile: ts.SourceFile): void {
    if (!this.diagnostics) return;
    this.diagnostics.push({
      severity: "warn",
      code: `union-resolution-${kind}`,
      component: this.currentClassName,
      file: sourceFile.fileName,
      message:
        kind === "no-checker"
          ? "Type checker not configured; literal union values cannot be resolved."
          : "Source file is not part of the configured ts.Program; literal union values cannot be resolved.",
    });
  }

  /**
   * Build a `ComponentMetadata` with the template XOR invariant enforced:
   * at most one of `template` / `templateUrl`. If both are present in the
   * decorator object, prefer inline `template` (analyzer convention).
   */
  private buildComponentMetadata(metadata: Record<string, unknown>): ComponentMetadata {
    const base: ComponentMetadataBase = {
      selector: asSelector(this.asString(metadata.selector) || ""),
      standalone: this.asBoolean(metadata.standalone, true),
      changeDetection: normalizeChangeDetection(this.asString(metadata.changeDetection)),
      encapsulation: normalizeEncapsulation(this.asString(metadata.encapsulation)),
      exportAs: this.asString(metadata.exportAs),
      styleUrls: this.asStringArray(metadata.styleUrls),
      imports: this.asStringArray(metadata.imports),
      providers: this.asStringArray(metadata.providers),
    };

    const template = this.asString(metadata.template);
    const templateUrl = this.asString(metadata.templateUrl);

    if (template !== undefined) {
      return { ...base, template };
    }
    if (templateUrl !== undefined) {
      return { ...base, templateUrl };
    }
    return base as ComponentMetadata;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private asBoolean(value: unknown, defaultValue: boolean): boolean {
    return typeof value === "boolean" ? value : defaultValue;
  }

  private asStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return value as string[];
    }
    return undefined;
  }

  private getDecoratorArguments(decorator: ts.Decorator, sourceFile: ts.SourceFile): Record<string, unknown> {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || expression.arguments.length === 0) {
      return {};
    }

    const arg = expression.arguments[0];

    // Handle string argument: @Input('alias')
    if (ts.isStringLiteral(arg)) {
      return { alias: arg.text };
    }

    // Handle object argument: @Input({ required: true, alias: 'name' })
    if (ts.isObjectLiteralExpression(arg)) {
      const result: Record<string, unknown> = {};
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          const key = prop.name.getText(sourceFile);
          const value = evaluateExpression(prop.initializer);
          result[key] = value;
        }
      }
      return result;
    }

    return {};
  }

  private extractDecoratorMetadata(decorator: ts.Decorator, sourceFile: ts.SourceFile): Record<string, unknown> {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression) || expression.arguments.length === 0) {
      return {};
    }

    const arg = expression.arguments[0];
    if (!ts.isObjectLiteralExpression(arg)) {
      return {};
    }

    const result: Record<string, unknown> = {};
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const key = prop.name.getText(sourceFile);
        result[key] = evaluateExpression(prop.initializer);
      }
    }

    return result;
  }

  private hasAccessModifier(node: ts.ParameterDeclaration): boolean {
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some(
      (m) =>
        m.kind === ts.SyntaxKind.PublicKeyword ||
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword ||
        m.kind === ts.SyntaxKind.ReadonlyKeyword,
    );
  }

  private isPublicMember(node: ts.ClassElement): boolean {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (!modifiers) return true; // No modifier = public by default

    return !modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
  }

  private isLifecycleHook(name: string): boolean {
    return lifecycleHooks.has(name);
  }

  /**
   * Infer a property declaration's type from its initializer when no explicit
   * annotation exists. Returns `null` when no useful inference is possible
   * (caller surfaces as `typeResolved: false`).
   */
  private inferType(node: ts.PropertyDeclaration): string | null {
    if (node.initializer) {
      return this.extractTypeFromInitializer(node.initializer);
    }
    return null;
  }

  /**
   * Extract a primitive/array/object type string from a literal initializer.
   * Returns `null` when the initializer shape carries no usable type info.
   * Array element shapes that can't be inferred yield a top-level `null`
   * (caller decides whether to surface as null-type or fall back to e.g.
   * 'unknown[]' — current callers surface as null).
   */
  private extractTypeFromInitializer(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return "string";
    if (ts.isNumericLiteral(node)) return "number";
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.length === 0) return null;
      const elementTypes = new Set<string | null>();
      for (const el of node.elements) {
        elementTypes.add(this.extractTypeFromInitializer(el));
      }
      if (elementTypes.size === 1) {
        const only = elementTypes.values().next().value as string | null;
        return only === null ? null : `${only}[]`;
      }
      return null;
    }
    if (ts.isObjectLiteralExpression(node)) return "object";
    return null;
  }
}

// ============================================================================
// Type Resolution Helpers
// ============================================================================

/**
 * Extract string/number literal values from a union type, tracking whether the
 * union mixes literal and non-literal members.
 *
 * Returns undefined when the type has no literal members at all (caller treats
 * as `not-union`). Returns `{ values, partial }` otherwise — `partial: true`
 * when at least one non-literal member (other than `undefined`/`null`) was
 * dropped.
 */
function extractLiteralValuesDetailed(type: ts.Type): { values: string[]; partial: boolean } | undefined {
  if (!type.isUnion()) return undefined;

  const literals: string[] = [];
  let droppedNonLiteral = false;
  for (const t of type.types) {
    if (t.isStringLiteral()) {
      literals.push(t.value);
    } else if (t.isNumberLiteral()) {
      literals.push(String(t.value));
    } else if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
      // undefined/null are common in optional unions — don't count as "partial".
    } else {
      droppedNonLiteral = true;
    }
  }
  if (literals.length === 0) return undefined;
  return { values: literals, partial: droppedNonLiteral };
}

// ============================================================================
// Enhanced Analysis Types (aliases for canonical types in types.ts)
// ============================================================================

import type { ConfigTokenInfo, ContentSlotInfo, DeprecationInfo, InheritanceInfo } from "../../types.js";

// ============================================================================
// Enum normalizers (map raw `asString` values onto the literal-union types)
// ============================================================================

function normalizeChangeDetection(v: string | undefined): "OnPush" | "Default" | null {
  if (v === "OnPush" || v === "Default") return v;
  if (v && v.endsWith(".OnPush")) return "OnPush";
  if (v && v.endsWith(".Default")) return "Default";
  return null;
}

function normalizeEncapsulation(v: string | undefined): "None" | "Emulated" | "ShadowDom" | null {
  if (v === "None" || v === "Emulated" || v === "ShadowDom") return v;
  if (v && v.endsWith(".None")) return "None";
  if (v && v.endsWith(".Emulated")) return "Emulated";
  if (v && v.endsWith(".ShadowDom")) return "ShadowDom";
  return null;
}

function normalizeProvidedIn(v: string | undefined): "root" | "platform" | "any" | null {
  if (v === "root" || v === "platform" || v === "any") return v;
  // Strip quotes produced by `asString` reading a string literal token.
  const stripped = v?.replace(/^['"]|['"]$/g, "");
  if (stripped === "root" || stripped === "platform" || stripped === "any") return stripped;
  return null;
}

export type InheritanceAnalysis = InheritanceInfo;
export type ContentSlotAnalysis = ContentSlotInfo;
export type DeprecationAnalysis = DeprecationInfo;
export type ConfigTokenAnalysis = ConfigTokenInfo;

// ============================================================================
// Enhanced AST Analyzer Methods
// ============================================================================

/**
 * Get a parsed SourceFile for `filePath`, preferring a shared `SourceFileCache`
 * when supplied so we parse each file at most once per CLI run. Falls back to a
 * fresh parse from disk. Returns undefined if the file does not exist.
 */
function getSourceFile(filePath: string, cache?: SourceFileCache): ts.SourceFile | undefined {
  if (cache) return cache.get(filePath);
  if (!fs.existsSync(filePath)) return undefined;
  const sourceCode = fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.ES2022, true);
}

/**
 * Result of `analyzeInheritance` — adds a `resolved` flag (v4.0) so callers
 * can surface unresolvable imports without making the analyzer silently fall
 * back to the same file (which produced misleading entries pre-v4.0).
 */
export interface InheritanceResult {
  analysis: InheritanceAnalysis;
  /** `false` when at least one base-class import failed to resolve. */
  resolved: boolean;
}

/**
 * Analyze inheritance chain for a component class.
 * Resolves base class inputs/outputs by reading the parent file.
 *
 * v4.0: when `resolveImportPath(...)` fails for a base class, returns
 * `resolved: false` and DOES NOT fall back to the current file (the old
 * behavior produced inputs/outputs that didn't actually belong to the base
 * class). The base name is still recorded so downstream tools can report it.
 */
export function analyzeInheritance(
  filePath: string,
  className: string,
  componentsRoot: string,
  existingAnalyzer?: AngularAstAnalyzer,
  importPrefix = "",
  cache?: SourceFileCache,
  diagnostics?: import("../../shared/diagnostics.js").DiagnosticsCollector,
): InheritanceResult {
  const result: Mutable<InheritanceAnalysis> = {
    inheritedInputs: [],
    inheritedOutputs: [],
    mixins: [],
  };
  let resolved = true;

  const sourceFile = getSourceFile(filePath, cache);
  if (!sourceFile) return { analysis: result, resolved };

  // Find the class declaration
  let classNode: ts.ClassDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === className) {
      classNode = node;
    }
  });

  if (!classNode) return { analysis: result, resolved };

  // Check for extends clause
  const heritageClauses = classNode.heritageClauses;
  if (!heritageClauses) return { analysis: result, resolved };

  for (const clause of heritageClauses) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const type of clause.types) {
        const baseClassName = type.expression.getText(sourceFile);
        result.baseClass = asClassName(baseClassName);

        // v4.0: do NOT fall back to `filePath` when import resolution fails.
        // The same-file fallback used to mis-attribute inputs/outputs from
        // unrelated classes that happened to live in the same file.
        const baseClassPath = resolveImportPath(
          sourceFile,
          baseClassName,
          filePath,
          componentsRoot,
          importPrefix,
          cache,
        );
        if (!baseClassPath) {
          resolved = false;
          diagnostics?.push({
            severity: "warn",
            code: "inheritance-unresolved-import",
            component: className,
            file: filePath,
            message: `Could not resolve import for base class "${baseClassName}" from ${className}.`,
          });
          continue;
        }
        result.baseClassPath = asFilePath(baseClassPath);

        // Analyze the base class file (reuse existing analyzer if provided)
        const analyzer = existingAnalyzer ?? new AngularAstAnalyzer();
        const baseAnalysis = analyzer.analyzeFile(baseClassPath);

        // Look for the base class in components and directives
        for (const comp of [...baseAnalysis.components, ...baseAnalysis.directives]) {
          if (comp.className === baseClassName) {
            result.inheritedInputs = [...comp.inputs];
            result.inheritedOutputs = [...comp.outputs];
            break;
          }
        }

        // If not found as component/directive, look as plain class with decorators
        if (result.inheritedInputs.length === 0 && result.inheritedOutputs.length === 0) {
          const inherited = extractInputsOutputsFromClass(baseClassPath, baseClassName, cache);
          result.inheritedInputs = inherited.inputs;
          result.inheritedOutputs = inherited.outputs;
        }
      }
    } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      for (const type of clause.types) {
        result.mixins.push(type.expression.getText(sourceFile));
      }
    }
  }

  return { analysis: result, resolved };
}

/**
 * Resolve import path for a class name from source file imports
 */
function resolveImportPath(
  sourceFile: ts.SourceFile,
  className: string,
  currentFilePath: string,
  componentsRoot: string,
  importPrefix = "",
  cache?: SourceFileCache,
): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!statement.importClause?.namedBindings) continue;

    const bindings = statement.importClause.namedBindings;
    if (!ts.isNamedImports(bindings)) continue;

    const hasClass = bindings.elements.some((el) => el.name.getText(sourceFile) === className);

    if (!hasClass) continue;

    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;

    // Handle <importPrefix>* imports
    if (importPrefix && moduleSpecifier.startsWith(importPrefix)) {
      const subpackage = moduleSpecifier.slice(importPrefix.length);
      // Try common patterns
      const candidates = [
        path.join(componentsRoot, subpackage, "index.ts"),
        path.join(componentsRoot, subpackage + ".ts"),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          // Resolve through re-exports
          return resolveReExport(candidate, className, componentsRoot, importPrefix, undefined, cache);
        }
      }
    }

    // Handle relative imports
    if (moduleSpecifier.startsWith(".")) {
      const dir = path.dirname(currentFilePath);
      const candidates = [path.resolve(dir, moduleSpecifier + ".ts"), path.resolve(dir, moduleSpecifier, "index.ts")];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return resolveReExport(candidate, className, componentsRoot, importPrefix, undefined, cache) || candidate;
        }
      }
    }
  }

  return undefined;
}

/**
 * Follow re-exports to find the actual file containing a class
 */
function resolveReExport(
  indexPath: string,
  className: string,
  componentsRoot: string,
  importPrefix = "",
  visited: Set<string> = new Set(),
  cache?: SourceFileCache,
): string | undefined {
  const MAX_DEPTH = 10;
  if (visited.size >= MAX_DEPTH || visited.has(indexPath)) return undefined;
  visited.add(indexPath);

  const sourceFile = getSourceFile(indexPath, cache);
  if (!sourceFile) return undefined;

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const moduleSpec = statement.moduleSpecifier.text;

    // Check if this export includes our class
    let includesClass = false;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      includesClass = statement.exportClause.elements.some((el) => el.name.getText(sourceFile) === className);
    } else if (!statement.exportClause) {
      // export * from '...' - might contain it
      includesClass = true;
    }

    if (!includesClass) continue;

    // Resolve the module path
    const dir = path.dirname(indexPath);
    let resolvedPath: string | undefined;

    if (moduleSpec.startsWith(".")) {
      const candidates = [path.resolve(dir, moduleSpec + ".ts"), path.resolve(dir, moduleSpec, "index.ts")];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          resolvedPath = candidate;
          break;
        }
      }
    } else if (importPrefix && moduleSpec.startsWith(importPrefix)) {
      const subpackage = moduleSpec.slice(importPrefix.length);
      resolvedPath = path.join(componentsRoot, subpackage, "index.ts");
    }

    if (resolvedPath) {
      if (fs.existsSync(resolvedPath)) {
        if (fileContainsClass(resolvedPath, className, cache)) {
          return resolvedPath;
        }
        // Might be another re-export
        const deeper = resolveReExport(resolvedPath, className, componentsRoot, importPrefix, visited, cache);
        if (deeper) return deeper;
      }
    }
  }

  // Check if the file itself contains the class (for direct files, not index.ts)
  if (fileContainsClass(indexPath, className, cache)) {
    return indexPath;
  }

  return undefined;
}

/**
 * Check if a file contains a class declaration with the given name using AST.
 */
function fileContainsClass(filePath: string, className: string, cache?: SourceFileCache): boolean {
  const sf = getSourceFile(filePath, cache);
  if (!sf) return false;
  let found = false;
  ts.forEachChild(sf, (node) => {
    if (ts.isClassDeclaration(node) && node.name?.getText(sf) === className) {
      found = true;
    }
  });
  return found;
}

/**
 * Extract @Input/@Output from a class that may not have @Component/@Directive decorator
 * (e.g. abstract base classes with @Directive() only)
 */
function extractInputsOutputsFromClass(
  filePath: string,
  className: string,
  cache?: SourceFileCache,
): { inputs: InputProperty[]; outputs: OutputProperty[] } {
  const inputs: InputProperty[] = [];
  const outputs: OutputProperty[] = [];

  const sourceFile = getSourceFile(filePath, cache);
  if (!sourceFile) return { inputs, outputs };

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    if (node.name?.getText(sourceFile) !== className) return;

    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) {
        const decorators = ts.getDecorators(member);
        if (!decorators) continue;

        for (const decorator of decorators) {
          const name = getDecoratorName(decorator);
          if (name === "Input") {
            const propName = member.name.getText(sourceFile);
            const type = member.type?.getText(sourceFile) ?? null;
            const defaultValue = member.initializer?.getText(sourceFile);
            inputs.push({
              name: propName,
              type,
              typeResolved: type !== null,
              defaultValue,
              required: false,
              description: extractJsDocComment(member),
              resolvedValues: null,
            });
          } else if (name === "Output") {
            const propName = member.name.getText(sourceFile);
            const eventType =
              (member.type ? extractTypeArgFromTypeNode(member.type, "")?.getText(sourceFile) : undefined) ?? null;
            outputs.push({
              name: propName,
              eventType,
              eventTypeResolved: eventType !== null,
              description: extractJsDocComment(member),
            });
          }
        }
      }
    }
  });

  return { inputs, outputs };
}

/**
 * Analyze content projection slots from component template.
 * Reads both inline and external templates.
 */
export function analyzeContentProjection(
  componentFilePath: string,
  cache?: SourceFileCache,
  templateParseCache?: TemplateParseCache,
  diagnostics?: DiagnosticsCollector,
): ContentSlotAnalysis[] {
  const slots: ContentSlotAnalysis[] = [];
  const sourceFile = getSourceFile(componentFilePath, cache);
  if (!sourceFile) return slots;

  let templateContent: string | undefined;
  let templateSourceUrl = componentFilePath;

  // Find @Component decorator and extract template/templateUrl
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const decorators = ts.getDecorators(node);
    if (!decorators) return;

    for (const decorator of decorators) {
      const name = getDecoratorName(decorator);
      if (name !== "Component") continue;

      const expr = decorator.expression;
      if (!ts.isCallExpression(expr) || expr.arguments.length === 0) continue;

      const arg = expr.arguments[0];
      if (!ts.isObjectLiteralExpression(arg)) continue;

      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.getText(sourceFile);

        if (key === "template") {
          // Inline template
          if (ts.isNoSubstitutionTemplateLiteral(prop.initializer) || ts.isStringLiteral(prop.initializer)) {
            templateContent = prop.initializer.text;
          } else if (ts.isTemplateExpression(prop.initializer)) {
            templateContent = prop.initializer.getText(sourceFile).replace(/^`|`$/g, "");
          }
        } else if (key === "templateUrl") {
          // External template — skip silently if not a plain string literal.
          if (!ts.isStringLiteral(prop.initializer) && !ts.isNoSubstitutionTemplateLiteral(prop.initializer)) continue;
          const templateUrl = prop.initializer.text;
          const templatePath = path.resolve(path.dirname(componentFilePath), templateUrl);
          if (fs.existsSync(templatePath)) {
            templateContent = fs.readFileSync(templatePath, "utf-8");
            templateSourceUrl = templatePath;
          }
        }
      }
    }
  });

  if (!templateContent) return slots;

  return parseNgContentSlots(templateContent, undefined, {
    sourceUrl: templateSourceUrl,
    cache: templateParseCache,
    diagnostics,
  });
}

export interface ParseNgContentSlotsOptions {
  sourceUrl?: string;
  cache?: TemplateParseCache;
  diagnostics?: DiagnosticsCollector;
}

/**
 * Parse ng-content slots from HTML template content.
 *
 * Uses `@angular/compiler`'s `parseTemplate` (via the shared `TemplateParseCache`)
 * to walk `<ng-content>` nodes — including those nested inside `@if`/`@for`/etc
 * control-flow blocks — and honor the real `required` attribute plus compound
 * selectors (`select="[foo], [bar]"`).
 *
 * On parser failure with no recovered nodes, emits a `template-parse-failed`
 * warn-severity diagnostic (when a collector is supplied) and returns an empty
 * slot list. If the parser reports errors but still produces nodes, we walk the
 * nodes and still emit the warn diagnostic.
 *
 * Exported so it can be reused for standalone HTML files.
 */
export function parseNgContentSlots(
  templateContent: string,
  existingNames?: Set<string>,
  opts: ParseNgContentSlotsOptions = {},
): ContentSlotAnalysis[] {
  const slots: ContentSlotAnalysis[] = [];
  const seenNames = existingNames ?? new Set<string>();
  const seenSelectorKeys = new Set<string>();
  const sourceUrl = opts.sourceUrl ?? "inline-template.html";
  const cache = opts.cache ?? new TemplateParseCache();

  let parsed: ReturnType<TemplateParseCache["get"]>;
  try {
    parsed = cache.get(templateContent, sourceUrl);
  } catch (err) {
    opts.diagnostics?.push({
      severity: "warn",
      code: "template-parse-failed",
      file: sourceUrl,
      message: `Failed to parse template (${sourceUrl}): ${err instanceof Error ? err.message : String(err)}`,
    });
    return slots;
  }

  const hasErrors = Array.isArray(parsed.errors) && parsed.errors.length > 0;
  const hasNodes = Array.isArray(parsed.nodes) && parsed.nodes.length > 0;

  if (hasErrors) {
    const firstError = parsed.errors?.[0];
    const msg = firstError
      ? typeof (firstError as { msg?: unknown }).msg === "string"
        ? (firstError as { msg: string }).msg
        : String(firstError)
      : "unknown error";
    // No recovered nodes → metadata is lost → error severity. Partial recovery
    // keeps warn (downstream still extracts slots from the recovered AST).
    opts.diagnostics?.push({
      severity: hasNodes ? "warn" : "error",
      code: "template-parse-failed",
      file: sourceUrl,
      message: `Template parse reported errors (${sourceUrl}): ${msg}`,
    });
    if (!hasNodes) return slots;
  }

  walkTemplate(parsed.nodes, {
    visitContent(content) {
      // Duck-type access — TmplAstContent exposes `attributes` (TextAttribute[])
      // with `.name` / `.value`. Read `select` and `required` there.
      const attrs =
        (content as unknown as { attributes?: readonly { name: string; value: string }[] }).attributes ?? [];
      let selectAttr: string | undefined;
      let requiredPresent = false;
      let ngProjectAs: string | undefined;
      for (const a of attrs) {
        if (a.name === "select") selectAttr = a.value;
        else if (a.name === "required") requiredPresent = true;
        else if (a.name === "ngProjectAs") ngProjectAs = a.value;
      }

      const selector = selectAttr && selectAttr.length > 0 ? selectAttr : undefined;
      const name = ngProjectAs || selector || "default";

      // Dedup by primary selector string (as today — regex dedup key was name,
      // which is equivalent since name derives from selector when present).
      const dedupKey = selector ?? "__default__";
      if (seenSelectorKeys.has(dedupKey)) return;
      seenSelectorKeys.add(dedupKey);
      if (seenNames.has(name)) return;
      seenNames.add(name);

      const alternates =
        selector && selector.includes(",")
          ? selector
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : undefined;

      const slot: Mutable<ContentSlotAnalysis> = {
        name,
        selector: selector ? asSelector(selector) : undefined,
        required: requiredPresent,
        multiple: !selector,
      };
      if (alternates && alternates.length > 1) {
        slot.selectorAlternates = alternates;
      }
      slots.push(slot);
    },
  });

  return slots;
}

/**
 * Extract @deprecated JSDoc info from a TypeScript node.
 */
export function extractDeprecation(
  filePath: string,
  className: string,
  cache?: SourceFileCache,
): DeprecationAnalysis | undefined {
  const sourceFile = getSourceFile(filePath, cache);
  if (!sourceFile) return undefined;

  let result: DeprecationAnalysis | undefined;

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    if (node.name?.getText(sourceFile) !== className) return;

    const tags = ts.getJSDocTags(node);
    for (const tag of tags) {
      if (tag.tagName.getText(sourceFile) === "deprecated") {
        const comment = typeof tag.comment === "string" ? tag.comment : ts.getTextOfJSDocComment(tag.comment);
        result = parseDeprecationComment(comment || "");
      }
    }

    // Also check leading comments for @deprecated
    if (!result) {
      const fullText = sourceFile.getFullText();
      const nodeStart = node.getFullStart();
      const leadingComments = ts.getLeadingCommentRanges(fullText, nodeStart);

      if (leadingComments) {
        for (const comment of leadingComments) {
          if (comment.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
            const commentText = fullText.slice(comment.pos, comment.end);
            if (commentText.includes("@deprecated")) {
              const deprecMatch = commentText.match(/@deprecated\s*(.*?)(?:\n\s*\*\s*@|\n\s*\*\/)/s);
              if (deprecMatch) {
                result = parseDeprecationComment(deprecMatch[1].replace(/\n\s*\*\s*/g, " ").trim());
              } else {
                result = { deprecated: true };
              }
            }
          }
        }
      }
    }
  });

  return result;
}

function parseDeprecationComment(comment: string): DeprecationAnalysis {
  const info: DeprecationAnalysis = { deprecated: true };

  // Parse "since vX.Y.Z" or "since X.Y.Z"
  const sinceMatch = comment.match(/since\s+v?(\d+\.\d+\.\d+)/i);
  if (sinceMatch) info.since = sinceMatch[1];

  // Parse "removed in vX.Y.Z" or "will be removed in vX.Y.Z"
  const removeMatch = comment.match(/(?:removed?\s+in|remove\s+(?:in|at))\s+v?(\d+\.\d+\.\d+)/i);
  if (removeMatch) info.removeIn = removeMatch[1];

  // Parse "use X instead" or "replaced by X"
  const replaceMatch = comment.match(/(?:use|replaced?\s+(?:by|with))\s+(\S+)\s+instead/i);
  if (replaceMatch) info.replacement = replaceMatch[1];

  // The full comment is the reason
  if (comment.trim()) info.reason = comment.trim();

  return info;
}

/**
 * Resolve config token from a .token.ts file.
 * Extracts InjectionToken, config interface, and default values.
 */
export function resolveConfigToken(tokenFilePath: string, cache?: SourceFileCache): ConfigTokenAnalysis[] {
  const results: ConfigTokenAnalysis[] = [];
  const sourceFile = getSourceFile(tokenFilePath, cache);
  if (!sourceFile) return results;

  // Collect all interfaces and their members
  const interfaces = new Map<string, TypeMember[]>();
  // Collect all const declarations with their values
  const constants = new Map<string, Record<string, unknown>>();
  // Collect all InjectionToken declarations
  const tokens: Array<{ name: string; typeName: string }> = [];

  ts.forEachChild(sourceFile, (node) => {
    // Collect interfaces
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      const members: TypeMember[] = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          const t = member.type?.getText(sourceFile) ?? null;
          members.push({
            name: member.name.getText(sourceFile),
            type: t,
            typeResolved: t !== null,
            optional: !!member.questionToken,
            description: extractJsDocComment(member),
          });
        }
      }
      interfaces.set(name, members);
    }

    // Collect variable declarations
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const varName = decl.name.getText(sourceFile);

        // Check if it's an InjectionToken via AST: new InjectionToken<Type>(...)
        if (decl.initializer && ts.isNewExpression(decl.initializer)) {
          const newExpr = decl.initializer;
          if (
            newExpr.expression.getText(sourceFile) === "InjectionToken" &&
            newExpr.typeArguments &&
            newExpr.typeArguments.length > 0
          ) {
            tokens.push({
              name: varName,
              typeName: newExpr.typeArguments[0].getText(sourceFile),
            });
          }
        }

        // Check if it's a DEFAULT_*_CONFIG or *_DEFAULT_CONFIG constant
        if ((varName.includes("DEFAULT") || varName.includes("default")) && decl.initializer) {
          if (ts.isObjectLiteralExpression(decl.initializer)) {
            const values = evaluateExpression(decl.initializer) as Record<string, unknown>;
            constants.set(varName, values);
          }
        }
      }
    }
  });

  // Match tokens with their interfaces and defaults
  for (const token of tokens) {
    const members = interfaces.get(token.typeName);
    if (!members) continue;

    // Find matching default config - try common naming patterns
    let defaultValues: Record<string, unknown> | undefined;
    for (const [constName, values] of constants) {
      // Match DEFAULT_X_CONFIG, X_DEFAULT_CONFIG etc.
      if (
        constName.toUpperCase().includes("DEFAULT") &&
        (constName.toUpperCase().includes(token.name.replace(/_CONFIG$/, "").toUpperCase()) ||
          constName.toUpperCase().includes(token.typeName.toUpperCase().replace("CONFIG", "")))
      ) {
        defaultValues = values;
        break;
      }
    }

    results.push({
      token: token.name,
      interface: token.typeName,
      properties: members,
      defaultValues,
      filePath: asFilePath(tokenFilePath),
    });
  }

  return results;
}

// ============================================================================
// Formatting Utilities
// ============================================================================

export function formatComponentAnalysis(analysis: ComponentAnalysis): string {
  let result = `# ${analysis.className}\n\n`;

  // Metadata
  result += `**Selector:** \`<${analysis.metadata.selector}>\`\n`;
  result += `**Standalone:** ${analysis.metadata.standalone}\n`;
  if (analysis.metadata.changeDetection) {
    result += `**Change Detection:** ${analysis.metadata.changeDetection}\n`;
  }
  result += `**Path:** ${analysis.filePath}\n\n`;

  if (analysis.jsDocDescription) {
    result += `## Description\n${analysis.jsDocDescription}\n\n`;
  }

  // Inputs
  if (analysis.inputs.length > 0) {
    result += `## Inputs (${analysis.inputs.length})\n\n`;
    result += "| Name | Type | Required | Default | Description |\n";
    result += "|------|------|----------|---------|-------------|\n";
    for (const input of analysis.inputs) {
      const required = input.required ? "✓" : "";
      const defaultVal = (!input.required && input.defaultValue) || "-";
      const desc = input.description || "-";
      result += `| \`${input.name}\` | \`${input.type}\` | ${required} | ${defaultVal} | ${desc} |\n`;
    }
    result += "\n";
  }

  // Outputs
  if (analysis.outputs.length > 0) {
    result += `## Outputs (${analysis.outputs.length})\n\n`;
    result += "| Name | Event Type | Description |\n";
    result += "|------|------------|-------------|\n";
    for (const output of analysis.outputs) {
      const desc = output.description || "-";
      result += `| \`${output.name}\` | \`${output.eventType}\` | ${desc} |\n`;
    }
    result += "\n";
  }

  // Public Methods
  if (analysis.publicMethods.length > 0) {
    result += `## Public Methods\n\n`;
    for (const method of analysis.publicMethods) {
      const params = method.parameters.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ");
      const asyncPrefix = method.isAsync ? "async " : "";
      result += `### ${asyncPrefix}${method.name}(${params}): ${method.returnType}\n`;
      if (method.description) {
        result += `${method.description}\n`;
      }
      result += "\n";
    }
  }

  // Dependencies
  if (analysis.dependencies.length > 0) {
    result += `## Dependencies\n\n`;
    for (const dep of analysis.dependencies) {
      const modifiers: string[] = [];
      if (dep.optional) modifiers.push("@Optional()");
      if (dep.self) modifiers.push("@Self()");
      if (dep.skipSelf) modifiers.push("@SkipSelf()");
      if (dep.host) modifiers.push("@Host()");
      const prefix = modifiers.length > 0 ? modifiers.join(" ") + " " : "";
      result += `- ${prefix}${dep.name}: ${dep.type}\n`;
    }
    result += "\n";
  }

  // Lifecycle Hooks
  const implementedHooks = analysis.lifecycleHooks.filter((h) => h.implemented);
  if (implementedHooks.length > 0) {
    result += `## Lifecycle Hooks\n`;
    result += implementedHooks.map((h) => `- ${h.name}`).join("\n") + "\n\n";
  }

  return result;
}

export function formatFileAnalysis(analysis: FileAnalysis): string {
  let result = `# File Analysis: ${path.basename(analysis.filePath)}\n\n`;

  // Components
  for (const component of analysis.components) {
    result += formatComponentAnalysis(component);
    result += "---\n\n";
  }

  // Directives
  for (const directive of analysis.directives) {
    result += `## Directive: ${directive.className}\n`;
    result += formatComponentAnalysis(directive);
    result += "---\n\n";
  }

  // Pipes
  for (const pipe of analysis.pipes) {
    result += `## Pipe: ${pipe.className}\n`;
    result += `**Name:** \`${pipe.pipeName}\`\n`;
    result += `**Pure:** ${pipe.pure}\n`;
    if (pipe.transformMethod) {
      const params = pipe.transformMethod.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
      result += `**Transform:** \`transform(${params}): ${pipe.transformMethod.returnType}\`\n`;
    }
    result += "\n---\n\n";
  }

  // Services
  for (const service of analysis.services) {
    result += `## Service: ${service.className}\n`;
    if (service.providedIn) {
      result += `**Provided In:** ${service.providedIn}\n`;
    }
    if (service.publicMethods.length > 0) {
      result += `### Public Methods\n`;
      for (const method of service.publicMethods) {
        const params = method.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
        result += `- \`${method.name}(${params}): ${method.returnType}\`\n`;
      }
    }
    result += "\n---\n\n";
  }

  // Exported Types
  if (analysis.exportedTypes.length > 0) {
    result += `## Exported Types\n\n`;
    for (const type of analysis.exportedTypes) {
      result += `### ${type.kind} ${type.name}\n`;
      result += "```typescript\n" + type.definition + "\n```\n\n";
    }
  }

  // Exported Functions
  if (analysis.exportedFunctions.length > 0) {
    result += `## Exported Functions\n\n`;
    for (const fn of analysis.exportedFunctions) {
      const params = fn.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
      result += `### ${fn.name}(${params}): ${fn.returnType}\n`;
      if (fn.description) {
        result += `${fn.description}\n`;
      }
      result += "\n";
    }
  }

  return result;
}
