import assert from "node:assert/strict";
import test from "node:test";
import { syncReleaseLock } from "./release-lock.mjs";

test("release metadata follows workspace versions without re-resolving native dependencies", () => {
  const lock = {
    lockfileVersion: 3,
    version: "3.2.0",
    packages: {
      "": { name: "agentium", version: "3.2.0", devDependencies: { vitest: "^4.0.18" } },
      "packages/core": { version: "3.2.0" },
      "packages/harness": { version: "3.2.0", peerDependencies: { "@agentium/core": "^3.2.0" } },
      "node_modules/native-linux": { version: "1.0.0", optional: true, os: ["linux"], integrity: "fixture" },
    },
  };
  const result = syncReleaseLock(lock, {
    "": { version: "3.3.0" },
    "packages/core": { version: "3.3.0" },
    "packages/harness": { version: "3.3.0", peerDependencies: { "@agentium/core": "^3.3.0" } },
  });
  assert.equal(result.version, "3.3.0");
  assert.equal(result.packages[""].version, "3.3.0");
  assert.equal(result.packages["packages/core"].version, "3.3.0");
  assert.deepEqual(result.packages["packages/harness"].peerDependencies, { "@agentium/core": "^3.3.0" });
  assert.deepEqual(result.packages["node_modules/native-linux"], lock.packages["node_modules/native-linux"]);
  assert.deepEqual(result.packages[""].devDependencies, lock.packages[""].devDependencies);
  assert.equal(lock.version, "3.2.0");
  assert.throws(() => syncReleaseLock(lock, { "": { version: "3.3.0" }, missing: { version: "3.3.0" } }), /missing/);
});
