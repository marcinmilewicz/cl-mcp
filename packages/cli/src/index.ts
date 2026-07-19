#!/usr/bin/env node
/**
 * `cl-mcp` bin entry — see main.ts for the command surface.
 */

import { runCli } from "./main.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error("Fatal:", error);
    process.exit(2);
  });
