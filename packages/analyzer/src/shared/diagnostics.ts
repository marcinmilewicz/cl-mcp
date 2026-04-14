/**
 * Diagnostics collector for analyzer runs.
 *
 * Introduced in schema v3.1. Replaces silent `catch {}` blocks in the CLI and
 * analyzers with structured diagnostics that are surfaced in the emitted
 * component-metadata.json and logged by the MCP server on load.
 */

import type { AnalyzerDiagnostic } from "../types.js";

export class DiagnosticsCollector {
  private items: AnalyzerDiagnostic[] = [];

  push(d: AnalyzerDiagnostic): void {
    this.items.push(d);
  }

  all(): AnalyzerDiagnostic[] {
    return this.items.slice();
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}
