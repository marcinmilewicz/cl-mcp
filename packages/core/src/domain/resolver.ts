/**
 * Component name resolution for @cl-mcp/mcp-server.
 *
 * Smart-resolves user input to component names using a cascade of strategies:
 * exact match -> selector match -> normalized selector -> word-subset -> fuzzy substring.
 *
 * Parametric — selector prefix comes from config, not hardcoded.
 */

import { getLibraryConfig } from "../config.js";
import { buildSearchMetadataMap, componentExists, getAvailableComponents, getMetadata } from "../data/metadata.js";
import type { ComponentMetadataFile } from "../types.js";
import { getSearchOptions, searchComponents } from "./search.js";

export type ResolveResult =
  | { resolved: string; matchedSelector?: string; type?: "component" | "directive" }
  | { suggestions: string[] }
  | { error: string };

export function resolveComponentName(input: string): ResolveResult {
  // 1. Exact match
  if (componentExists(input)) {
    return { resolved: input };
  }

  const components = getAvailableComponents();
  const metadata = getMetadata();

  // 2. Selector match
  const selectorResult = matchBySelector(input, metadata);
  if (selectorResult) return selectorResult;

  // 3. Fuzzy substring match
  return matchBySubstring(input, components);
}

// ── Private helpers ─────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchBySelector(input: string, metadata: ComponentMetadataFile): ResolveResult | null {
  if (!metadata.selectorMap) return null;

  const config = getLibraryConfig();
  const selectorPrefix = config.selectorPrefix;
  const prefixRegex = selectorPrefix ? new RegExp(`^${escapeRegex(selectorPrefix)}`) : null;

  const cleanSelector = input.replace(/^</, "").replace(/>$/, "");

  // Direct selector lookup
  const directEntry = metadata.selectorMap[cleanSelector];
  if (directEntry && componentExists(directEntry.component)) {
    return { resolved: directEntry.component, matchedSelector: cleanSelector, type: directEntry.type || "component" };
  }

  // Try with brackets for attribute selectors
  if (!directEntry) {
    const bracketSelector = `[${cleanSelector}]`;
    const bracketEntry = metadata.selectorMap[bracketSelector];
    if (bracketEntry && componentExists(bracketEntry.component)) {
      return {
        resolved: bracketEntry.component,
        matchedSelector: bracketSelector,
        type: bracketEntry.type || "directive",
      };
    }
  }

  // Try with prefix + brackets
  if (!directEntry && selectorPrefix) {
    const prefixedBracketSelector = `[${selectorPrefix.replace(/-$/, "")}${cleanSelector.charAt(0).toUpperCase()}${cleanSelector.slice(1)}]`;
    const prefixedEntry = metadata.selectorMap[prefixedBracketSelector];
    if (prefixedEntry && componentExists(prefixedEntry.component)) {
      return {
        resolved: prefixedEntry.component,
        matchedSelector: prefixedBracketSelector,
        type: prefixedEntry.type || "directive",
      };
    }
  }

  // Normalize input into word parts
  const words = cleanSelector
    .toLowerCase()
    .replace(prefixRegex ?? /(?:)/, "")
    .replace(/[\s_]+/g, "-")
    .split("-")
    .filter(Boolean);

  if (words.length === 0) return null;

  // Try exact word order with prefix
  if (selectorPrefix) {
    const directSelector = `${selectorPrefix}${words.join("-")}`;
    const directMatch = metadata.selectorMap[directSelector];
    if (directMatch && componentExists(directMatch.component)) {
      return {
        resolved: directMatch.component,
        matchedSelector: directSelector,
        type: directMatch.type || "component",
      };
    }

    // Try sorted word order
    const sortedSelector = `${selectorPrefix}${[...words].sort().join("-")}`;
    if (sortedSelector !== directSelector) {
      const sortedMatch = metadata.selectorMap[sortedSelector];
      if (sortedMatch && componentExists(sortedMatch.component)) {
        return {
          resolved: sortedMatch.component,
          matchedSelector: sortedSelector,
          type: sortedMatch.type || "component",
        };
      }
    }
  }

  // Word-subset match against all selectors
  const inputSorted = [...words].sort();
  for (const [selector, entry] of Object.entries(metadata.selectorMap)) {
    const selectorClean = prefixRegex ? selector.replace(prefixRegex, "") : selector;
    const selectorWords = selectorClean.split("-").sort();
    const isExactWordMatch =
      inputSorted.length === selectorWords.length && inputSorted.every((w, i) => w === selectorWords[i]);
    if (isExactWordMatch && componentExists(entry.component)) {
      return { resolved: entry.component, matchedSelector: selector, type: entry.type || "component" };
    }
  }

  return null;
}

function matchBySubstring(input: string, components: string[]): ResolveResult {
  const normalizedInput = input.toLowerCase().replace(/[-_]/g, "");
  const candidates = components.filter((name) => {
    const normalizedName = name.toLowerCase().replace(/[-_]/g, "");
    return normalizedName.includes(normalizedInput) || normalizedInput.includes(normalizedName);
  });

  if (candidates.length === 1) {
    return { resolved: candidates[0] };
  }
  if (candidates.length > 1) {
    return { suggestions: candidates };
  }

  return matchBySemanticSearch(input, components);
}

function matchBySemanticSearch(input: string, components: string[]): ResolveResult {
  const metadataMap = buildSearchMetadataMap(components);
  const options = getSearchOptions();
  const results = searchComponents(input, components, metadataMap, options);

  if (results.length === 1) {
    return { resolved: results[0].name, matchedSelector: results[0].matchedSelector };
  }
  if (results.length > 1) {
    return { suggestions: results.map((r) => r.name) };
  }

  return { error: `Component "${input}" does not exist.\n\nAvailable components:\n${components.join(", ")}` };
}
