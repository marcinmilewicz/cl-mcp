/**
 * Test helper: build an in-memory ts.Program from a { filename: source } map.
 * Used by analyzer tests to exercise real TypeScript AST behavior without
 * touching the filesystem.
 */

import ts from "typescript";

export interface VirtualProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  getSourceFile: (fileName: string) => ts.SourceFile;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  allowJs: false,
};

/**
 * Build a ts.Program backed entirely by in-memory source files.
 * Host falls back to the real filesystem ONLY for default lib lookups
 * (typescript ships those inside its own package), so the Program can
 * successfully type-check the virtual inputs.
 */
export function createVirtualProgram(
  files: Record<string, string>,
  options: ts.CompilerOptions = COMPILER_OPTIONS,
): VirtualProgram {
  const realHost = ts.createCompilerHost(options, true);
  const virtualSources = new Map<string, ts.SourceFile>();

  for (const [name, source] of Object.entries(files)) {
    const scriptKind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    virtualSources.set(
      name,
      ts.createSourceFile(name, source, options.target ?? ts.ScriptTarget.ES2022, true, scriptKind),
    );
  }

  const host: ts.CompilerHost = {
    ...realHost,
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      if (virtualSources.has(fileName)) return virtualSources.get(fileName);
      return realHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    fileExists: (fileName) => virtualSources.has(fileName) || realHost.fileExists(fileName),
    readFile: (fileName) => {
      const virtual = virtualSources.get(fileName);
      if (virtual) return virtual.getFullText();
      return realHost.readFile(fileName);
    },
    writeFile: () => {
      /* no-op: tests do not emit */
    },
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
  };

  const program = ts.createProgram({
    rootNames: Object.keys(files),
    options,
    host,
  });

  return {
    program,
    checker: program.getTypeChecker(),
    getSourceFile: (fileName: string) => {
      const sf = program.getSourceFile(fileName);
      if (!sf) throw new Error(`virtual program missing source file: ${fileName}`);
      return sf;
    },
  };
}

/**
 * Find the first class declaration by name in a source file.
 */
export function findClass(sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration {
  let found: ts.ClassDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === className) {
      found = node;
    }
  });
  if (!found) throw new Error(`class ${className} not found`);
  return found;
}
