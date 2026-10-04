import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { defineConfig } from "tsdown";

// npm workspace scripts run with the package directory as cwd.
const name = basename(process.cwd());
const entry: Record<string, string> = { index: "src/index.ts" };
if (name === "core") {
  entry["voice/index"] = "src/voice/index.ts";
  entry["telephony/index"] = "src/telephony/index.ts";
  entry["tools/sandbox-worker"] = "src/tools/sandbox-worker.ts";
  for (const file of readdirSync("src/toolkits").filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")))
    entry[`toolkits/${file.slice(0, -3)}`] = `src/toolkits/${file}`;
}
if (name === "harness") entry.testing = "src/testing.ts";
if (name === "cli") entry.bin = "src/bin.ts";

export default defineConfig({
  cwd: process.cwd(),
  entry,
  format: ["esm", "cjs"],
  target: "node22.18",
  dts: false, // tsc remains the single declaration producer.
  shims: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
  outExtensions: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
});
