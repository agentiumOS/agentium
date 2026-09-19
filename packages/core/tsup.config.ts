import { readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

const TOOLKIT_DIR = join(import.meta.dirname ?? __dirname, "src/toolkits");

/**
 * Every toolkit gets its own entry so `@agentium/core/toolkits/github` pulls in
 * one file instead of the whole catalog, and the main barrel stays small.
 */
const toolkitEntries = readdirSync(TOOLKIT_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => `src/toolkits/${f}`);

export default defineConfig({
  entry: ["src/index.ts", "src/tools/sandbox-worker.ts", ...toolkitEntries],
  format: ["esm", "cjs"],
  dts: false,
  shims: true,
  clean: true,
  splitting: true,
  treeshake: true,
});
