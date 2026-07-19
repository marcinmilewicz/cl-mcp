// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

// GitHub Pages is served from https://<user>.github.io/<repo>/, so the site is
// the user page and `base` is the repository name. Starlight resolves all
// internal links against `base` automatically — author links root-relative.
const site = "https://marcinmilewicz.github.io";
const base = "/cl-mcp";

// https://astro.build/config
export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "cl-mcp",
      description:
        "An MCP server that gives LLMs accurate, build-time metadata for Angular and React component libraries.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/marcinmilewicz/cl-mcp",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/marcinmilewicz/cl-mcp/edit/main/packages/docs/",
      },
      lastUpdated: true,
      // starlight-typedoc generates the API Reference from the public entry
      // points of @cl-mcp/core and @cl-mcp/analyzer at build time. The packages
      // must be built first (npm run build) so cross-package `@cl-mcp/*` type
      // imports resolve — the docs:build script and CI both do this.
      plugins: [
        starlightTypeDoc({
          entryPoints: ["../core/src/index.ts", "../analyzer/src/index.ts"],
          tsconfig: "./tsconfig.typedoc.json",
          output: "api",
          sidebar: { label: "API Reference", collapsed: true },
          typeDoc: {
            skipErrorChecking: true,
            useCodeBlocks: true,
            parametersFormat: "table",
            propertiesFormat: "table",
            enumMembersFormat: "table",
            expandObjects: true,
            entryPointStrategy: "resolve",
          },
        }),
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Installation", slug: "getting-started/installation" },
            { label: "Quick Start", slug: "getting-started/quick-start" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "The Pipeline", slug: "guides/pipeline" },
            { label: "Multi-Library Workspaces", slug: "guides/workspaces" },
            { label: "Optional @angular/compiler", slug: "guides/angular-compiler" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "MCP Tools", slug: "reference/mcp-tools" },
            { label: "cl-mcp CLI", slug: "reference/cli" },
          ],
        },
        // Auto-generated group from starlight-typedoc.
        typeDocSidebarGroup,
      ],
    }),
  ],
});
