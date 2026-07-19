/**
 * Workspace configuration — `cl-mcp.yaml` (or `.json`; the YAML parser
 * accepts both).
 *
 * The config file is the primary interface for multi-library analysis:
 *
 * ```yaml
 * outputDir: ./data
 * defaults:
 *   componentLayout: auto
 * libraries:
 *   - path: libs/ui                    # everything else auto-detected
 *   - path: libs/forms
 *     framework: angular
 *     importAlias: "@myorg/forms"
 *     prefix: org-
 * scan:
 *   - dir: libs
 *     exclude: ["*-e2e", "*-testing"]
 * ```
 *
 * Precedence: CLI flags > per-library config > `defaults` > auto-detection.
 * Validation is a Zod trust boundary — a typo in a key fails loudly with
 * every offending path listed, mirroring the MCP server's metadata schema.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { SupportedFramework } from "../types.js";

export const COMPONENT_LAYOUTS = ["auto", "directory-per-component", "flat"] as const;
export type ComponentLayout = (typeof COMPONENT_LAYOUTS)[number];

const LibraryEntrySchema = z
  .object({
    path: z.string().min(1),
    name: z.string().optional(),
    framework: z.enum(["angular", "react"]).optional(),
    importAlias: z.string().optional(),
    prefix: z.string().optional(),
    importPrefix: z.string().optional(),
    componentLayout: z.enum(COMPONENT_LAYOUTS).optional(),
    storybook: z.string().optional(),
    docs: z.string().optional(),
  })
  .strict();

const ScanEntrySchema = z
  .object({
    dir: z.string().min(1),
    exclude: z.array(z.string()).optional(),
  })
  .strict();

const DefaultsSchema = z
  .object({
    componentLayout: z.enum(COMPONENT_LAYOUTS).optional(),
    prefix: z.string().optional(),
    allowPartial: z.boolean().optional(),
  })
  .strict();

export const WorkspaceConfigSchema = z
  .object({
    outputDir: z.string().optional(),
    defaults: DefaultsSchema.optional(),
    libraries: z.array(LibraryEntrySchema).optional(),
    scan: z.array(ScanEntrySchema).optional(),
  })
  .strict();

export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export interface LoadedWorkspaceConfig {
  config: WorkspaceConfig;
  /** Directory the config file lives in — all relative paths resolve from here. */
  rootDir: string;
  configPath: string;
}

export const DEFAULT_CONFIG_FILENAMES = ["cl-mcp.yaml", "cl-mcp.yml", "cl-mcp.json"];

/** Parse + validate a workspace config file. Throws with every issue listed. */
export function loadWorkspaceConfig(configPath: string): LoadedWorkspaceConfig {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`[cl-mcp] Workspace config not found: ${absolute}`);
  }
  const raw = fs.readFileSync(absolute, "utf-8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`[cl-mcp] Could not parse ${absolute} as YAML/JSON: ${err instanceof Error ? err.message : err}`);
  }

  const result = WorkspaceConfigSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const p = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${p}: ${issue.message}`;
    });
    throw new Error(`[cl-mcp] ${absolute} failed config validation:\n${issues.join("\n")}`);
  }

  if (!result.data.libraries?.length && !result.data.scan?.length) {
    throw new Error(`[cl-mcp] ${absolute} must define at least one of 'libraries' or 'scan'.`);
  }

  return { config: result.data, rootDir: path.dirname(absolute), configPath: absolute };
}

/** Look for a default-named config file in (or above) the given directory. */
export function findWorkspaceConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    for (const name of DEFAULT_CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Re-exported for consumers assembling configs programmatically.
export type { SupportedFramework };
