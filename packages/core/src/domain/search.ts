/**
 * Semantic Search Engine
 *
 * Generic keyword expansion and fuzzy matching for component discovery.
 * Parametric selector prefix — no hardcoded library values.
 */

import { getLibraryConfig } from "../config.js";

// ── Types ────────────────────────────────────────────────────────

export interface ComponentSearchMeta {
  llmSummary?: string;
  selectors?: string[];
}

export interface SearchResult {
  name: string;
  score: number;
  reasons: string[];
  matchedSelector?: string;
}

export interface SearchOptions {
  selectorPrefix: string;
  keywordExpansions: Record<string, string[]>;
}

// ── Score weights ────────────────────────────────────────────────

const SCORE = {
  EXACT_SELECTOR: 20,
  PARTIAL_SELECTOR: 15,
  NAME: 10,
  KEYWORD: 8,
  SELECTOR_SUBSTRING: 5,
  SUMMARY: 3,
} as const;

// ── Internal helpers ─────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPrefixRegex(prefix: string): RegExp | null {
  return prefix ? new RegExp(`^${escapeRegex(prefix)}`) : null;
}

function toSortedKey(s: string): string {
  return s.split("-").sort().join("-");
}

function normalizeQuery(query: string, prefixRegex: RegExp | null): { normalized: string; words: string[] } {
  let q = query.trim();
  q = q.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  if (prefixRegex) {
    q = q.replace(prefixRegex, "");
  }
  const words = q.split(/[\s\-_]+/).filter(Boolean);
  return { normalized: words.join("-"), words };
}

function stripPrefix(selector: string, prefixRegex: RegExp | null): string {
  return prefixRegex ? selector.replace(prefixRegex, "").toLowerCase() : selector.toLowerCase();
}

// ── Selector matching (3-tier) ───────────────────────────────────

interface SelectorMatch {
  selector: string;
  score: number;
  reason: string;
}

function matchSelectorExact(selectors: string[], normalized: string, prefixRegex: RegExp | null): SelectorMatch | null {
  const normalizedSorted = toSortedKey(normalized);
  for (const selector of selectors) {
    const stripped = stripPrefix(selector, prefixRegex);
    if (stripped === normalized || toSortedKey(stripped) === normalizedSorted) {
      return { selector, score: SCORE.EXACT_SELECTOR, reason: "exact selector match" };
    }
  }
  return null;
}

function matchSelectorPartial(
  selectors: string[],
  normalized: string,
  prefixRegex: RegExp | null,
): SelectorMatch | null {
  const queryWords = normalized.split("-");
  for (const selector of selectors) {
    const stripped = stripPrefix(selector, prefixRegex);
    const selectorWords = stripped.split("-");
    const isWordSubset =
      queryWords.every((w) => selectorWords.includes(w)) || selectorWords.every((w) => queryWords.includes(w));
    const isStringSubset = stripped.includes(normalized) || normalized.includes(stripped);
    if (isWordSubset || isStringSubset) {
      return { selector, score: SCORE.PARTIAL_SELECTOR, reason: "partial selector match" };
    }
  }
  return null;
}

function matchSelectorSubstring(selectors: string[], words: string[]): SelectorMatch | null {
  for (const selector of selectors) {
    if (words.every((w) => selector.toLowerCase().includes(w))) {
      return { selector, score: SCORE.SELECTOR_SUBSTRING, reason: "selector keyword match" };
    }
  }
  return null;
}

function matchSelector(
  selectors: string[],
  normalized: string,
  words: string[],
  componentName: string,
  prefixRegex: RegExp | null,
): SelectorMatch | null {
  const exact = matchSelectorExact(selectors, normalized, prefixRegex);
  if (exact) return exact;

  if (normalized === componentName.toLowerCase()) return null;

  return matchSelectorPartial(selectors, normalized, prefixRegex) ?? matchSelectorSubstring(selectors, words);
}

// ── Per-component scoring ────────────────────────────────────────

interface ScoreContext {
  normalized: string;
  words: string[];
  prefixRegex: RegExp | null;
  keywordExpansions: Record<string, string[]>;
}

function scoreComponent(
  componentName: string,
  meta: ComponentSearchMeta | undefined,
  ctx: ScoreContext,
): SearchResult | null {
  let score = 0;
  const reasons: string[] = [];
  let matchedSelector: string | undefined;

  if (meta?.selectors) {
    const hit = matchSelector(meta.selectors, ctx.normalized, ctx.words, componentName, ctx.prefixRegex);
    if (hit) {
      score += hit.score;
      reasons.push(hit.reason);
      matchedSelector = hit.selector;
    }
  }

  const nameLower = componentName.toLowerCase();
  if (nameLower.includes(ctx.normalized) || ctx.normalized.includes(nameLower)) {
    score += SCORE.NAME;
    reasons.push("name match");
  }

  for (const word of ctx.words) {
    const expanded = ctx.keywordExpansions[word];
    if (expanded?.includes(componentName)) {
      score += SCORE.KEYWORD;
      reasons.push(`keyword "${word}"`);
    }
  }

  if (meta?.llmSummary) {
    const summaryLower = meta.llmSummary.toLowerCase();
    if (ctx.words.some((w) => summaryLower.includes(w))) {
      score += SCORE.SUMMARY;
      reasons.push("summary match");
    }
  }

  if (score === 0) return null;

  return { name: componentName, score, reasons: [...new Set(reasons)], matchedSelector };
}

// ── Public API ───────────────────────────────────────────────────

export function searchComponents(
  query: string,
  components: string[],
  componentMetadata: Map<string, ComponentSearchMeta> | undefined,
  options: SearchOptions,
): SearchResult[] {
  const prefixRegex = buildPrefixRegex(options.selectorPrefix);
  const { normalized, words } = normalizeQuery(query, prefixRegex);
  const ctx: ScoreContext = { normalized, words, prefixRegex, keywordExpansions: options.keywordExpansions };

  return components
    .map((name) => scoreComponent(name, componentMetadata?.get(name), ctx))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => b.score - a.score);
}

// ── Default keyword expansions ───────────────────────────────────

export const DEFAULT_KEYWORD_EXPANSIONS: Record<string, string[]> = {
  dropdown: ["select", "autocomplete", "listbox"],
  notification: ["toast", "feedback-panel", "snackbar", "snack-bar"],
  modal: ["modals", "dialog"],
  popup: ["modals", "tooltip", "dialog"],
  dialog: ["modals", "dialog"],
  button: ["buttons", "button"],
  table: ["tables", "table"],
  date: ["datepicker", "month-picker", "calendar"],
  calendar: ["datepicker", "month-picker"],
  file: ["file-picker"],
  upload: ["file-picker"],
  switch: ["content-switcher", "switchers", "slide-toggle"],
  toggle: ["content-switcher", "checkbox", "slide-toggle"],
  icon: ["icons", "icon"],
  tab: ["tabs"],
  chip: ["tag", "chips"],
  tag: ["tag", "chips"],
  badge: ["badge"],
  tooltip: ["tooltip"],
  spinner: ["spinner", "progress-spinner"],
  loader: ["spinner", "progress-spinner", "progress-bar"],
  progress: ["spinner", "progress-spinner", "progress-bar"],
  radio: ["radio"],
  check: ["checkbox"],
  text: ["input"],
  input: ["input"],
  textarea: ["textarea"],
  menu: ["context-menu", "menu"],
  panel: ["drawer", "feedback-panel", "expansion-panel"],
  sidebar: ["drawer", "sidenav"],
  form: ["input", "labels", "checkbox", "radio", "form-field"],
  label: ["labels", "form-field"],
  search: ["autocomplete"],
  nav: ["tabs", "sidenav", "toolbar"],
  list: ["list"],
  card: ["card"],
  divider: ["divider"],
  accordion: ["expansion-panel"],
  stepper: ["stepper"],
  paginator: ["paginator"],
  sort: ["sort"],
  tree: ["tree"],
};

/** Build search options using the current library config and default expansions. */
export function getSearchOptions(): SearchOptions {
  const config = getLibraryConfig();
  return {
    selectorPrefix: config.selectorPrefix,
    keywordExpansions: DEFAULT_KEYWORD_EXPANSIONS,
  };
}
