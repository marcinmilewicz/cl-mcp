// Expressive Code / Shiki themes tuned to the cl-mcp "Blueprint" palette.
// Two accents (blueprint blue + construction orange) plus a supporting teal,
// comments in a muted hairline tone — a restrained, drafting-sheet syntax
// palette rather than a rainbow. Consumed by astro.config.mjs.

/** @param {string} bg @param {string} fg @param {Record<string,string>} c */
function tokens(c) {
  return [
    { scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: c.comment, fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "modifier"], settings: { foreground: c.keyword, fontStyle: "bold" } },
    { scope: ["string", "string.template", "punctuation.definition.string"], settings: { foreground: c.string } },
    { scope: ["constant.numeric", "constant.language", "constant.language.boolean", "constant.character"], settings: { foreground: c.number } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic", "variable.function"], settings: { foreground: c.func } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class", "entity.other.inherited-class", "entity.name.namespace"], settings: { foreground: c.type } },
    { scope: ["variable", "variable.other", "variable.parameter", "meta.definition.variable"], settings: { foreground: c.fg } },
    { scope: ["variable.other.constant", "variable.other.enummember"], settings: { foreground: c.number } },
    { scope: ["variable.other.property", "meta.property.object", "support.variable.property", "variable.other.object.property"], settings: { foreground: c.property } },
    { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator", "punctuation.accessor"], settings: { foreground: c.punct } },
    { scope: ["entity.name.tag", "punctuation.definition.tag"], settings: { foreground: c.keyword } },
    { scope: ["entity.other.attribute-name"], settings: { foreground: c.type, fontStyle: "italic" } },
    { scope: ["support.type.property-name.json", "support.type.property-name"], settings: { foreground: c.property } },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: c.keyword, fontStyle: "bold" } },
    { scope: ["markup.inline.raw", "markup.raw.block"], settings: { foreground: c.string } },
    { scope: ["meta.diff", "markup.deleted"], settings: { foreground: c.string } },
    { scope: ["markup.inserted"], settings: { foreground: c.type } },
    { scope: ["invalid", "invalid.illegal"], settings: { foreground: c.string } },
  ];
}

/** Light — blueprint on drafting paper. */
export const blueprintLight = {
  name: "blueprint-light",
  type: "light",
  colors: {
    "editor.background": "#e4ebf0",
    "editor.foreground": "#1c3a4d",
  },
  settings: tokens({
    fg: "#1c3a4d",
    comment: "#557184",
    keyword: "#155d8a",
    string: "#b0561f",
    number: "#a05e1a",
    func: "#0f5c86",
    type: "#2a6d8c",
    property: "#0f5c86",
    punct: "#4f7288",
  }),
};

/** Dark — cyanotype. */
export const blueprintDark = {
  name: "blueprint-dark",
  type: "dark",
  colors: {
    "editor.background": "#0f2130",
    "editor.foreground": "#cfe0ea",
  },
  settings: tokens({
    fg: "#cfe0ea",
    comment: "#6d8ba0",
    keyword: "#4aa8dd",
    string: "#e6874a",
    number: "#e0a35a",
    func: "#7cc4ea",
    type: "#5bb8c4",
    property: "#9fd0ea",
    punct: "#8199ab",
  }),
};
