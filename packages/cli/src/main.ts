/**
 * `cl-mcp` CLI — command-line access to component library metadata.
 *
 * A thin shell adapter over `@cl-mcp/core`: every query command calls the
 * EXACT same tool handlers the MCP server dispatches to, so CLI and MCP
 * output can never drift. Designed for LLM agents with shell access (no MCP
 * client required) as much as for humans.
 *
 * Contract:
 *   - results go to stdout (markdown by default, JSON via --json)
 *   - logs/diagnostics go to stderr
 *   - exit 0 = success, 1 = tool rejected (validation errors, unknown
 *     component), 2 = operational error (bad usage, missing metadata)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findWorkspaceConfig, loadWorkspaceConfig } from "@cl-mcp/analyzer";
import {
  TOOL_HANDLERS,
  type ToolResponse,
  getActiveLibrary,
  getLibraryNames,
  loadPreloadedMetadata,
  withLibrary,
} from "@cl-mcp/core";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export const USAGE = `cl-mcp — component library metadata for LLMs and humans

Usage: cl-mcp <command> [options]

Commands:
  generate [args...]        Run the analyzer (forwards to cl-mcp-analyze;
                            single-library flags or --config/--scan/--lib)
  list-libraries            List loaded libraries [--json]
  overview                  Library overview / quick reference [--library X] [--json]
  find [query...]           Search components (no query = list all) [--library X] [--list-all]
  get <name...>             Component details; multiple names = batch
                            [--detail api|full|examples|types] [--library X]
  validate                  Validate a usage snippet against real APIs
                            (--code "<...>" | --file f | stdin) --components a,b [--library X]

Metadata resolution (query commands):
  --metadata <path>         component-metadata.json (single library)
  --data-dir <path>         directory of per-library metadata (multi-library)
  otherwise: CL_MCP_METADATA_PATH / CL_MCP_DATA_DIR env vars,
  then cl-mcp.yaml's outputDir (discovered upward from cwd), then ./data.

Exit codes: 0 = ok, 1 = validation/tool error, 2 = operational error.`;

// ── Argument helpers ────────────────────────────────────────────────

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["json", "list-all", "help"]);

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`--${key} requires a value`);
    }
    flags.set(key, next);
    i++;
  }
  return { positionals, flags };
}

class UsageError extends Error {}

// ── Metadata loading ────────────────────────────────────────────────

let loaded = false;

function ensureMetadataLoaded(flags: Map<string, string | true>): void {
  if (loaded) return;

  const metadata = flags.get("metadata");
  const dataDir = flags.get("data-dir");
  if (typeof metadata === "string") {
    process.env.CL_MCP_METADATA_PATH = path.resolve(metadata);
  } else if (typeof dataDir === "string") {
    process.env.CL_MCP_DATA_DIR = path.resolve(dataDir);
  } else if (!process.env.CL_MCP_METADATA_PATH && !process.env.CL_MCP_DATA_DIR) {
    // Fall back to the workspace config's outputDir when discoverable.
    const configPath = findWorkspaceConfig(process.cwd());
    if (configPath) {
      try {
        const { config, rootDir } = loadWorkspaceConfig(configPath);
        const outputDir = path.resolve(rootDir, config.outputDir ?? "./data");
        if (fs.existsSync(outputDir)) {
          process.env.CL_MCP_DATA_DIR = outputDir;
        }
      } catch {
        // Invalid config — let the server-side resolution report the miss.
      }
    }
  }

  loadPreloadedMetadata();
  loaded = true;
}

/** Test-only: allow reloading against a different data dir. */
export function __resetCliForTests(): void {
  loaded = false;
}

// ── Tool invocation ─────────────────────────────────────────────────

function emit(response: ToolResponse, io: CliIo): number {
  io.out(response.content.map((c) => c.text).join("\n"));
  return response.isError ? 1 : 0;
}

function callTool(name: string, args: Record<string, unknown>, io: CliIo): number {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return emit(handler(args), io);
}

// ── Commands ────────────────────────────────────────────────────────

function commandGenerate(argv: string[]): number {
  const require = createRequire(import.meta.url);
  const analyzerPkgPath = require.resolve("@cl-mcp/analyzer/package.json");
  const analyzerPkg = JSON.parse(fs.readFileSync(analyzerPkgPath, "utf-8")) as { bin?: Record<string, string> };
  const binRel = analyzerPkg.bin?.["cl-mcp-analyze"];
  if (!binRel) throw new Error("@cl-mcp/analyzer does not expose the cl-mcp-analyze bin");
  const binPath = path.join(path.dirname(analyzerPkgPath), binRel);

  const result = spawnSync(process.execPath, [binPath, ...argv], { stdio: "inherit" });
  return result.status ?? 2;
}

function commandListLibraries(parsed: ParsedArgs, io: CliIo): number {
  ensureMetadataLoaded(parsed.flags);
  const rows = getLibraryNames().map((name) =>
    withLibrary(name, () => {
      const lib = getActiveLibrary();
      return {
        name,
        packageName: lib.config.packageName,
        framework: lib.config.framework ?? "angular",
        components: Object.keys(lib.metadata.components).length,
        metadataPath: lib.metadataPath,
      };
    }),
  );

  if (parsed.flags.has("json")) {
    io.out(JSON.stringify(rows, null, 2));
  } else {
    io.out("| Library | Package | Framework | Components |");
    io.out("|---------|---------|-----------|------------|");
    for (const row of rows) {
      io.out(`| ${row.name} | ${row.packageName} | ${row.framework} | ${row.components} |`);
    }
  }
  return 0;
}

function commandOverview(parsed: ParsedArgs, io: CliIo): number {
  ensureMetadataLoaded(parsed.flags);
  return callTool(
    "get_library_overview",
    {
      format: parsed.flags.has("json") ? "json" : "text",
      library: parsed.flags.get("library"),
    },
    io,
  );
}

function commandFind(parsed: ParsedArgs, io: CliIo): number {
  ensureMetadataLoaded(parsed.flags);
  const query = parsed.positionals.join(" ").trim();
  return callTool(
    "find_components",
    {
      query: query || undefined,
      list_all: parsed.flags.has("list-all") || undefined,
      library: parsed.flags.get("library"),
    },
    io,
  );
}

function commandGet(parsed: ParsedArgs, io: CliIo): number {
  if (parsed.positionals.length === 0) {
    throw new UsageError("get requires at least one component name");
  }
  ensureMetadataLoaded(parsed.flags);
  const detail = parsed.flags.get("detail");
  const shared = {
    detail_level: typeof detail === "string" ? detail : undefined,
    library: parsed.flags.get("library"),
  };

  if (parsed.positionals.length === 1) {
    return callTool("get_component", { componentName: parsed.positionals[0], ...shared }, io);
  }
  return callTool("get_components_batch", { componentNames: parsed.positionals, ...shared }, io);
}

function commandValidate(parsed: ParsedArgs, io: CliIo): number {
  const componentsFlag = parsed.flags.get("components");
  if (typeof componentsFlag !== "string" || componentsFlag.trim() === "") {
    throw new UsageError('validate requires --components "a,b,c"');
  }
  const componentNames = componentsFlag
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let code: string;
  const codeFlag = parsed.flags.get("code");
  const fileFlag = parsed.flags.get("file");
  if (typeof codeFlag === "string") {
    code = codeFlag;
  } else if (typeof fileFlag === "string") {
    code = fs.readFileSync(path.resolve(fileFlag), "utf-8");
  } else {
    code = fs.readFileSync(0, "utf-8"); // stdin
  }

  ensureMetadataLoaded(parsed.flags);
  return callTool("validate_usage", { code, componentNames, library: parsed.flags.get("library") }, io);
}

// ── Entry point ─────────────────────────────────────────────────────

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "help") {
    io.out(USAGE);
    return command ? 0 : 2;
  }

  try {
    // `generate` forwards argv verbatim (the analyzer CLI has its own parser).
    if (command === "generate") return commandGenerate(rest);

    const parsed = parseCliArgs(rest);
    if (parsed.flags.has("help")) {
      io.out(USAGE);
      return 0;
    }

    switch (command) {
      case "list-libraries":
        return commandListLibraries(parsed, io);
      case "overview":
        return commandOverview(parsed, io);
      case "find":
        return commandFind(parsed, io);
      case "get":
        return commandGet(parsed, io);
      case "validate":
        return commandValidate(parsed, io);
      default:
        io.err(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`Error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
