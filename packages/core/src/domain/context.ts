/**
 * Quick Context Generation (for LLM efficiency)
 *
 * Generates compact component reference data optimized for LLM consumption.
 * Parametric — uses config for library-specific names.
 */

import { getLibraryConfig } from "../config.js";
import { getAnalyzedEntry, getAvailableComponents, getMetadata } from "../data/metadata.js";
import type { QuickContext, SelectorQuickInfo } from "../types.js";

export function generateQuickContext(): QuickContext {
  const metadata = getMetadata();
  const components = getAvailableComponents();
  const config = getLibraryConfig();
  const importCheatsheet: Record<string, string> = {};

  const importHint = (componentName: string): string =>
    (config.framework ?? "angular") === "react"
      ? `import { ${componentName.split(".")[0]} } from '${config.packageName}';`
      : `import { ... } from '${config.packageName}/${componentName}';`;

  if (metadata.selectorMap) {
    for (const componentName of components) {
      importCheatsheet[componentName] = importHint(componentName);
    }

    return {
      version: metadata.version,
      totalComponents: components.length,
      selectorMap: metadata.selectorMap,
      importCheatsheet,
    };
  }

  // Fallback: compute at runtime
  const selectorMap: Record<string, SelectorQuickInfo> = {};

  for (const componentName of components) {
    const preloaded = getAnalyzedEntry(componentName);
    if (!preloaded) continue;

    importCheatsheet[componentName] = importHint(componentName);

    for (const analysis of preloaded.analysis) {
      for (const comp of analysis.components) {
        if (!comp.metadata.selector) continue;
        if (comp.metadata.selector.startsWith("test-") || comp.metadata.selector.startsWith("storybook-")) continue;

        const sortedInputs = [...comp.inputs].sort((a, b) => {
          if (a.required && !b.required) return -1;
          if (!a.required && b.required) return 1;
          return a.name.localeCompare(b.name);
        });

        const mainInputs = sortedInputs.slice(0, 5).map((i) => (i.required ? `${i.name}*` : i.name));
        const mainOutputs = comp.outputs.slice(0, 3).map((o) => o.name);
        const formControl = comp.inputs.some((i) => i.name === "formControl" || i.name === "formControlName");

        selectorMap[comp.metadata.selector] = {
          component: componentName,
          mainInputs,
          mainOutputs,
          formControl: formControl || undefined,
        };
      }

      for (const dir of analysis.directives || []) {
        if (!dir.metadata.selector) continue;
        const rawSelector = dir.metadata.selector.replace(/[\[\]]/g, "");
        if (rawSelector.startsWith("test-") || rawSelector.startsWith("storybook-")) continue;

        const mainInputs = dir.inputs.slice(0, 5).map((i) => (i.required ? `${i.name}*` : i.name));
        const mainOutputs = dir.outputs.slice(0, 3).map((o) => o.name);
        selectorMap[dir.metadata.selector] = {
          component: componentName,
          mainInputs,
          mainOutputs,
        };
      }
    }
  }

  return {
    version: metadata.version,
    totalComponents: components.length,
    selectorMap,
    importCheatsheet,
  };
}

// Memoized per library — the active library can be switched per request
// (multi-library mode), so a single cache slot would leak contexts across
// libraries.
const cachedQuickContexts = new Map<string, QuickContext>();

export function getQuickContext(): QuickContext {
  const key = getLibraryConfig().packageName;
  let ctx = cachedQuickContexts.get(key);
  if (!ctx) {
    ctx = generateQuickContext();
    cachedQuickContexts.set(key, ctx);
  }
  return ctx;
}

export function formatQuickContextForLLM(): string {
  const ctx = getQuickContext();
  const components = getAvailableComponents();
  const config = getLibraryConfig();

  let result = `# ${config.packageName} Quick Reference\n\n`;
  result += `**${ctx.totalComponents} components available**\n\n`;

  result += "## CRITICAL RULES\n";
  result += "1. ONLY use inputs/outputs listed in the table below - do NOT hallucinate props\n";
  result += "2. Use `validate_template` tool BEFORE returning any template\n";
  result += "3. Check `get_component` for full API when unsure\n\n";

  result += "## Selector → Inputs Map\n";
  result += "(* = required input)\n\n";
  result += "| Selector | Type | Main Inputs | Outputs | Form | Notes |\n";
  result += "|----------|------|-------------|---------|------|-------|\n";

  for (const [selector, info] of Object.entries(ctx.selectorMap)) {
    const inputs = info.mainInputs.join(", ") || "-";
    const outputs = info.mainOutputs.join(", ") || "-";
    const form = info.formControl ? "✓" : "";
    const notes: string[] = [];
    const type = info.type === "directive" ? "directive" : "component";
    if (info.hasContentSlots) notes.push("slots");
    if (info.deprecated) notes.push("deprecated");
    if (info.configRequired && info.configRequired.length > 0) notes.push(`needs:${info.configRequired.join(",")}`);
    const notesStr = notes.length > 0 ? notes.join(", ") : "";
    result += `| \`${selector}\` | ${type} | ${inputs} | ${outputs} | ${form} | ${notesStr} |\n`;
  }

  // Directive and pipe tables
  const directiveRows: Array<{ selector: string; component: string; className: string }> = [];
  const pipeRows: Array<{ pipeName: string; component: string; className: string }> = [];

  for (const componentName of components) {
    const preloaded = getAnalyzedEntry(componentName);
    if (!preloaded) continue;

    for (const analysis of preloaded.analysis) {
      if (analysis.directives) {
        for (const directive of analysis.directives) {
          if (directive.metadata.selector) {
            const rawSelector = directive.metadata.selector.replace(/[\[\]]/g, "");
            if (rawSelector.startsWith("test-") || rawSelector.startsWith("storybook-")) continue;
            directiveRows.push({
              selector: directive.metadata.selector,
              component: componentName,
              className: directive.className,
            });
          }
        }
      }
      if (analysis.pipes) {
        for (const pipe of analysis.pipes) {
          pipeRows.push({ pipeName: pipe.pipeName, component: componentName, className: pipe.className });
        }
      }
    }
  }

  if (directiveRows.length > 0) {
    result += "\n## Key Directives\n";
    result += "| Directive | Component | Class |\n|-----------|-----------|-------|\n";
    for (const row of directiveRows) {
      result += `| \`${row.selector}\` | ${row.component} | ${row.className} |\n`;
    }
  }

  if (pipeRows.length > 0) {
    result += "\n## Available Pipes\n";
    result += "| Pipe | Component | Class |\n|------|-----------|-------|\n";
    for (const row of pipeRows) {
      result += `| \`${row.pipeName}\` | ${row.component} | ${row.className} |\n`;
    }
  }

  return result;
}
