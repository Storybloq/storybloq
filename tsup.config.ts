import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  // ISS-1022: `presence` is a SEPARATE entry, and its own bin, because the
  // presence hook fires on every PreToolUse and PostToolUse. Bundling it into
  // cli.js would cost ~310ms twice per tool call just to parse code it does not
  // use. Its import graph is asserted in test/presence/presence-wiring.test.ts.
  entry: {
    cli: "src/cli/index.ts",
    index: "src/index.ts",
    mcp: "src/mcp/index.ts",
    presence: "src/hooks/presence-entry.ts",
  },
  dts: true,
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  shims: true,
  define: {
    "process.env.STORYBLOQ_VERSION": JSON.stringify(pkg.version),
  },
});
