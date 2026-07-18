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

export const USAGE = `cl-mcp — grounded component-library knowledge for LLM agents and humans

Usage: cl-mcp <command> [options]
       cl-mcp help <command>      # detailed help with examples (also: <command> --help)

Commands:
  list-libraries   What libraries are loaded (names, frameworks, component counts)
  overview         Quick reference of ALL components — selectors/JSX names + main props
  find             Search components by name, keyword, or intent ("date picker")
  get              Full API of one or more components (props, callbacks, slots, types)
  validate         Check a template/JSX snippet against the REAL component APIs
  generate         Produce component-metadata.json from library sources (analyzer)

RECOMMENDED AGENT WORKFLOW (before writing any component code):
  1. cl-mcp overview                     # learn what exists
  2. cl-mcp find "searchable dropdown"   # narrow down by intent
  3. cl-mcp get Select.Root              # ground the exact API
  4. cl-mcp validate --components Select.Root --code '<Select.Root ...>'
     → exit 0 means every prop is real; exit 1 lists what is hallucinated.

Output contract (script/agent friendly):
  stdout = the result (markdown by default, JSON via --json where supported)
  stderr = logs and diagnostics only
  exit 0 = success | 1 = tool rejected (validation failed, unknown component)
  | 2 = operational error (bad usage, metadata not found)

Metadata resolution (all query commands, first match wins):
  --metadata <path>   a single component-metadata.json
  --data-dir <path>   directory with per-library metadata (multi-library mode)
  CL_MCP_METADATA_PATH / CL_MCP_DATA_DIR environment variables
  cl-mcp.yaml outputDir (config discovered upward from cwd), then ./data

Component names: use the public name ("Dialog.Root", "mat-button", "button").
Internal/alternate forms resolve too ("DialogRoot" → Dialog.Root). On
multi-library data, qualify with the library ("ui:Button") or pass --library.`;

/** Per-command help — written for LLM consumption: exact examples, semantics, pitfalls. */
export const COMMAND_HELP: Record<string, string> = {
  "list-libraries": `cl-mcp list-libraries — what metadata is loaded

Usage: cl-mcp list-libraries [--json] [--metadata <path> | --data-dir <path>]

Returns one row per library: name (the qualifier for lib:Name), package,
framework (angular|react), component count. Start here on multi-library data
to learn the valid --library values.

Examples:
  cl-mcp list-libraries --data-dir ./data
  cl-mcp list-libraries --json          # [{"name":"ui","framework":"react",...}]`,

  overview: `cl-mcp overview — compact reference of every component

Usage: cl-mcp overview [--library <lib>] [--json] [--metadata <path> | --data-dir <path>]

Markdown table: selector/JSX name, type, main props (* = required), outputs,
notes (slots/deprecated). Multi-library data renders one section per library
unless --library scopes it. Use this FIRST — it prevents inventing components
that don't exist. --json returns the raw selector map + import cheatsheet.

Examples:
  cl-mcp overview --library ui
  cl-mcp overview --json --metadata ./data/ui/component-metadata.json`,

  find: `cl-mcp find — search components by name, keyword, or intent

Usage: cl-mcp find [query words...] [--library <lib>] [--list-all]

Semantic search over names, selectors, and summaries; returns the top matches
with match reasons. No query = flat listing of everything (--list-all for a
compact version). Query can be natural language — synonyms like "dropdown"
expand to select/autocomplete-style components.

Examples:
  cl-mcp find date picker
  cl-mcp find "notification toast" --library ui
  cl-mcp find --list-all`,

  get: `cl-mcp get — the exact API of one or more components

Usage: cl-mcp get <name...> [--detail api|full|examples|types] [--library <lib>]

THE grounding step: returns every real prop/input (type, required, default,
literal-union values), callback/output, and content slot. Do NOT guess props —
if it is not listed here, it does not exist.

Names: public form preferred ("Dialog.Root", "button", "mat-card"); internal
("DialogRoot") and selector forms resolve too; qualify as "lib:Name" on
multi-library data. Multiple names = one batched response.

Detail levels:
  api      (default) strict inputs/outputs/slots reference
  full     + inheritance, config tokens, related components, README
  examples usage patterns and Storybook examples
  types    exported TypeScript types verbatim

Examples:
  cl-mcp get Dialog.Root
  cl-mcp get Button forms:input --detail full
  cl-mcp get select --detail examples`,

  validate: `cl-mcp validate — reject hallucinated props BEFORE returning code

Usage: cl-mcp validate --components <a,b,...> (--code '<...>' | --file <path> | stdin)
                       [--library <lib>]

Framework-dispatched: JSX validation for React libraries, Angular template
validation for Angular libraries. Checks prop/input NAMES (with spelling
suggestions) and required props. List EVERY component used in the snippet in
--components (comma-separated; both "Dialog.Root" and "DialogRoot" forms work).

Semantics an agent must know:
  - exit 0 = all props exist; exit 1 = violations listed on stdout
  - {...spread} props: required-prop checks are skipped for that element
  - prop VALUES are not checked (variant="nonsense" passes; use \`get\` for
    the allowed literal values)
  - unregistered/DOM elements are ignored, never flagged
  - Angular validation needs the optional \`@angular/compiler\` peer dependency
    installed; without it the result is a single angular-compiler-unavailable
    error (React/JSX validation is unaffected)

Examples:
  cl-mcp validate --components Dialog.Root --code '<Dialog.Root defaultOpen={true} />'
  cl-mcp validate --components button,card --file snippet.html
  echo '<Button variant="ghost" />' | cl-mcp validate --components Button`,

  generate: `cl-mcp generate — produce component-metadata.json from sources

Usage: cl-mcp generate [analyzer args...]     (forwards to cl-mcp-analyze)

Single library:
  cl-mcp generate --framework angular|react --path <src> --package <name>
                  [--prefix <sel-prefix>] [--storybook <dir>] [--docs <file>]
                  [--output <file>]
Workspace (multi-library):
  cl-mcp generate --config ./cl-mcp.yaml
  cl-mcp generate --lib libs/ui --lib libs/forms --output-dir ./data
  cl-mcp generate --scan libs --output-dir ./data

Workspace mode auto-detects each library's framework and writes one metadata
file per library plus workspace-manifest.json (cross-library import graph).
React tip: have react + @types/react resolvable from the analyzed sources,
or prop-type resolution degrades sharply.`,
};

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

  if (!command || command === "--help") {
    io.out(USAGE);
    return command ? 0 : 2;
  }

  // `help` / `help <command>` — detailed, example-driven help per command.
  if (command === "help") {
    const topic = rest[0];
    if (topic && COMMAND_HELP[topic]) {
      io.out(COMMAND_HELP[topic]);
    } else if (topic) {
      io.err(`Unknown command: ${topic}\n\n${USAGE}`);
      return 2;
    } else {
      io.out(USAGE);
    }
    return 0;
  }

  try {
    // `generate` forwards argv verbatim (the analyzer CLI has its own parser) —
    // except --help, which shows our generate help instead of spawning.
    if (command === "generate") {
      if (rest.includes("--help")) {
        io.out(COMMAND_HELP.generate);
        return 0;
      }
      return commandGenerate(rest);
    }

    const parsed = parseCliArgs(rest);
    if (parsed.flags.has("help")) {
      io.out(COMMAND_HELP[command] ?? USAGE);
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
