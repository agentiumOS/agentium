import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runChecks(checks) {
  const results = await Promise.all(
    checks.map(async ({ name, run }) => {
      const start = performance.now();
      try {
        await run();
        console.log(`${name}: passed (${Math.round(performance.now() - start)}ms)`);
        return true;
      } catch (error) {
        console.error(`${name}: failed (${Math.round(performance.now() - start)}ms): ${error.message}`);
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

function node(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`node ${args.join(" ")} exited ${signal ?? code}`));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = [
    "core",
    "harness",
    "transport",
    "queue",
    "browser",
    "eval",
    "observability",
    "admin",
    "edge",
    "cli",
  ];
  const success = await runChecks([
    {
      name: "types",
      run: async () => {
        for (const name of packages)
          await node([
            "node_modules/typescript/bin/tsc",
            "-p",
            `packages/${name}/tsconfig.json`,
            "--noEmit",
            "--pretty",
            "false",
          ]);
      },
    },
    { name: "lint", run: () => node(["node_modules/@biomejs/biome/bin/biome", "ci", "."]) },
    {
      name: "release metadata",
      run: () =>
        node([
          "--test",
          "scripts/release-lock.test.mjs",
          "scripts/cjs-declarations.test.mjs",
          "scripts/release-artifacts.test.mjs",
          "scripts/ci-checks.test.mjs",
        ]),
    },
    { name: "tests", run: () => node(["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2"]) },
  ]);
  if (!success) process.exitCode = 1;
}
