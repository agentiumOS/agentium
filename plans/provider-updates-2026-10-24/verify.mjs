import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = [
  "packages/core/src/models/__tests__/google-argon.test.ts",
  "packages/core/src/models/__tests__/google-ollama-controls.test.ts",
  "packages/core/src/models/__tests__/openai-api.test.ts",
  "packages/core/src/models/__tests__/decision-input.test.ts",
  "packages/core/src/models/__tests__/openai-decisions.test.ts",
  "packages/core/src/models/__tests__/billing-context-agent.test.ts",
  "packages/core/src/models/__tests__/model-alias-accounting.test.ts",
  "packages/core/src/models/__tests__/usage-conformance.test.ts",
  "packages/core/src/cost/__tests__/reviewed-pricing.test.ts",
  "packages/core/src/cost/__tests__/accounting-lifecycle.test.ts",
];

const full = process.argv.slice(2);
if (full.length > 1 || (full.length === 1 && full[0] !== "--full")) {
  process.stderr.write("Usage: node plans/provider-updates-2026-10-24/verify.mjs [--full]\n");
  process.exit(2);
}
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...(full.length ? [] : files)], {
  cwd: root,
  env: { ...process.env, VITEST_MAX_WORKERS: "2" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
