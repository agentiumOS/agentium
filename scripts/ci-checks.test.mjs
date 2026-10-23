import assert from "node:assert/strict";
import test from "node:test";
import { runChecks } from "./ci-checks.mjs";

test("CI starts independent groups together and waits for successes after a failure", async () => {
  const started = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const running = runChecks([
    {
      name: "failed",
      run: async () => {
        started.push("failed");
        throw new Error("fixture failure");
      },
    },
    {
      name: "slow",
      run: async () => {
        started.push("slow");
        await pending;
        started.push("completed");
      },
    },
  ]);
  await Promise.resolve();
  assert.deepEqual(started, ["failed", "slow"]);
  let finished = false;
  running.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release();
  assert.equal(await running, false);
  assert.deepEqual(started, ["failed", "slow", "completed"]);
});

test("CI succeeds only when every group succeeds", async () => {
  assert.equal(await runChecks([{ name: "ok", run: async () => {} }]), true);
});
