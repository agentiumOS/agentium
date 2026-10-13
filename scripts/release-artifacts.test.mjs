import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  packRelease,
  parseReleaseOptions,
  preflightRelease,
  publishRelease,
  verifyRelease,
} from "./release-artifacts.mjs";

const exec = promisify(execFile);
const sourceRef = "a".repeat(40);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agentium-release-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  const artifacts = join(directory, "artifacts");
  await mkdir(root);
  const files = ["package.json", "package-lock.json"];
  const packages = {};
  for (const name of ["core", "harness"]) {
    const workspace = `packages/${name}`;
    await mkdir(join(root, workspace, "dist"), { recursive: true });
    const metadata = {
      name: `@agentium/${name}`,
      version: "4.9.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      scripts: {
        prepack: "node -e 'throw new Error(\"Packing must not rebuild\")'",
        prepublishOnly: "node -e 'throw new Error(\"Publishing must not rebuild\")'",
      },
      ...(name === "harness" ? { peerDependencies: { "@agentium/core": "^4.9.0" } } : {}),
    };
    await writeFile(join(root, workspace, "package.json"), JSON.stringify(metadata));
    await writeFile(join(root, workspace, "dist/index.js"), `export const name = ${JSON.stringify(name)};\n`);
    files.push(`${workspace}/package.json`);
    packages[workspace] = {
      name: metadata.name,
      version: metadata.version,
      ...("peerDependencies" in metadata ? { peerDependencies: metadata.peerDependencies } : {}),
    };
  }
  const metadata = { name: "release-fixture", private: true, version: "4.9.0", workspaces: Object.keys(packages) };
  await writeFile(join(root, "package.json"), JSON.stringify(metadata));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, version: "4.9.0", packages: { "": metadata, ...packages } }),
  );
  const execute = async (command, args, options) => {
    if (command !== "git") return exec(command, args, options);
    if (args[0] === "ls-files") return { stdout: `${files.join("\0")}\0` };
    if (args[0] === "status") return { stdout: "" };
    if (args[0] === "rev-parse") return { stdout: `${sourceRef}\n` };
    throw new Error(`Unexpected git command: ${args.join(" ")}`);
  };
  const download = (url) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1)).split("/")[1].split("@")[0];
    return readFile(join(artifacts, `agentium-${name}-4.9.0.tgz`));
  };
  return { root, directory: artifacts, ref: sourceRef, tag: "v4.9.0", execute, download };
}

function missingVersion() {
  return Object.assign(new Error("Registry version is absent"), {
    stdout: JSON.stringify({ error: { code: "E404" } }),
  });
}

function registryExecutor(options, lookup, upload) {
  return async (command, args, executionOptions) => {
    if (command === "npm" && args[0] === "view")
      return {
        stdout: JSON.stringify({
          integrity: await lookup(args[1]),
          tarball: `https://registry.npmjs.org/${encodeURIComponent(args[1])}`,
        }),
      };
    if (command === "npm" && args[0] === "publish") return upload(args);
    return options.execute(command, args, executionOptions);
  };
}

async function packedFixture(t) {
  const options = await fixture(t);
  const result = await packRelease(options);
  return { options, manifest: result.manifest, manifestSha256: result.manifestSha256 };
}

test("retains independently usable tarballs and their source identity without running build scripts", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  assert.equal(manifest.version, "4.9.0");
  assert.equal(manifest.source.sha, sourceRef);
  assert.deepEqual(
    manifest.packages.map((entry) => entry.name),
    ["@agentium/core", "@agentium/harness"],
  );
  assert.ok(manifest.packages.every((entry) => entry.files.some((file) => file.path === "dist/index.js")));
  const verified = await verifyRelease({ ...options, manifestSha256 });
  assert.equal(verified.manifestSha256, manifestSha256);
  assert.equal(verified.manifest.packages.length, 2);
});

test("preflight rejects mismatched tag, workspace and lockfile versions", async (t) => {
  const options = await fixture(t);
  assert.equal((await preflightRelease(options)).sha, sourceRef);
  await assert.rejects(preflightRelease({ ...options, tag: "v4.8.3" }), /version/i);
  await assert.rejects(preflightRelease({ ...options, tag: "main" }), /tag/i);
  const lockPath = join(options.root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["packages/harness"].version = "4.8.3";
  await writeFile(lockPath, JSON.stringify(lock));
  await assert.rejects(preflightRelease(options), /lockfile/i);
});

test("dirty source cannot become a release tag or retained release artifact", async (t) => {
  const options = await fixture(t);
  const execute = (command, args, executionOptions) =>
    command === "git" && args[0] === "status"
      ? { stdout: " M package.json\n" }
      : options.execute(command, args, executionOptions);
  await assert.rejects(preflightRelease({ ...options, execute }), /clean source/i);
  await assert.rejects(packRelease({ ...options, execute }), /clean source/i);
});

test("retained artifacts cannot be written into a checkout child whose name starts with dots", async (t) => {
  const options = await fixture(t);
  await assert.rejects(packRelease({ ...options, directory: join(options.root, "..artifacts") }), /outside/i);
});

test("packing refuses prepare hooks before older npm can execute an unverified rebuild", async (t) => {
  const options = await fixture(t);
  const path = join(options.root, "packages/harness/package.json");
  const metadata = JSON.parse(await readFile(path, "utf8"));
  metadata.scripts.prepare = "node -e 'throw new Error(\"Unexpected prepare execution\")'";
  await writeFile(path, JSON.stringify(metadata));
  await assert.rejects(packRelease(options), /prepare hooks/i);
});

test("packing rejects credentials hidden under otherwise allowed distribution roots", async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.root, "packages/core/dist/.env"), "fixture-only");
  await assert.rejects(packRelease(options), /credential|prohibited/i);
});

test("packing allows relative declaration maps without embedded sources and rejects unsafe or runtime maps", async (t) => {
  const options = await fixture(t);
  const mapPath = join(options.root, "packages/core/dist/index.d.ts.map");
  const declarationMap = {
    version: 3,
    file: "index.d.ts",
    sourceRoot: "",
    sources: ["../src/index.ts"],
    names: [],
    mappings: "",
  };
  await writeFile(mapPath, JSON.stringify(declarationMap));
  const packed = await packRelease(options);
  assert.ok(packed.manifest.packages[0].files.some((entry) => entry.path === "dist/index.d.ts.map"));
  await verifyRelease({ ...options, manifestSha256: packed.manifestSha256 });
  await writeFile(
    mapPath,
    JSON.stringify({ ...declarationMap, sourcesContent: ["export const privateSource = true"] }),
  );
  await assert.rejects(packRelease(options), /embedded source/i);
  for (const source of ["/private/index.ts", "../../outside.ts", "C:\\private\\index.ts", "https://private/index.ts"]) {
    await writeFile(mapPath, JSON.stringify({ ...declarationMap, sources: [source] }));
    await assert.rejects(packRelease(options), /unsafe source/i);
  }
  await rm(mapPath);
  await writeFile(join(options.root, "packages/core/dist/index.js.map"), JSON.stringify(declarationMap));
  await assert.rejects(packRelease(options), /runtime source map/i);
});

test("registry metadata with matching integrity cannot certify different served bytes", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  let uploaded = false;
  const execute = registryExecutor(
    options,
    async () => manifest.packages[0].integrity,
    async () => {
      uploaded = true;
    },
  );
  await assert.rejects(
    publishRelease({ ...options, manifestSha256, execute, download: async () => Buffer.from("wrong registry bytes") }),
    /registry_bytes_mismatch/i,
  );
  assert.equal(uploaded, false);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "failed");
});

test("verification rejects source substitution, changed inputs, manifest tampering and changed tarball bytes", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  await assert.rejects(verifyRelease({ ...options, ref: "b".repeat(40), manifestSha256 }), /source/i);
  const packagePath = join(options.root, "packages/core/package.json");
  const original = await readFile(packagePath);
  await writeFile(packagePath, `${original}\n`);
  await assert.rejects(verifyRelease({ ...options, manifestSha256 }), /source/i);
  await writeFile(packagePath, original);
  const manifestPath = join(options.directory, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  await writeFile(manifestPath, `${manifestBytes}\n`);
  await assert.rejects(verifyRelease({ ...options, manifestSha256 }), /manifest/i);
  await writeFile(manifestPath, manifestBytes);
  const tarball = join(options.directory, manifest.packages[0].filename);
  await writeFile(tarball, Buffer.concat([await readFile(tarball), Buffer.from("changed")]));
  await assert.rejects(verifyRelease({ ...options, manifestSha256 }), /integrity|bytes/i);
});

test("resume skips a matching registry version and publishes the remaining retained tarball", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  const registry = new Map([["@agentium/core@4.9.0", manifest.packages[0].integrity]]);
  const uploaded = [];
  const execute = registryExecutor(
    options,
    async (name) => {
      if (!registry.has(name)) throw missingVersion();
      return registry.get(name);
    },
    async (args) => {
      uploaded.push(args);
      registry.set("@agentium/harness@4.9.0", manifest.packages[1].integrity);
      return { stdout: "published" };
    },
  );
  const outcomes = await publishRelease({ ...options, manifestSha256, execute });
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0][1], join(options.directory, manifest.packages[1].filename));
  assert.ok(uploaded[0].includes("--ignore-scripts"));
  assert.ok(!uploaded[0].some((arg) => arg.startsWith("--workspace")));
  assert.deepEqual(
    outcomes.packages.map((entry) => entry.status),
    ["verified_published", "verified_published"],
  );
  assert.equal(outcomes.packages[0].action, "already_present");
  assert.deepEqual(JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8")), outcomes);
});

test("differing registry bytes halt the entire release before publishing any missing packages", async (t) => {
  const { options, manifestSha256 } = await packedFixture(t);
  let uploaded = false;
  const execute = registryExecutor(
    options,
    async (name) => {
      if (name.startsWith("@agentium/core@")) throw missingVersion();
      return "sha512-different";
    },
    async () => {
      uploaded = true;
    },
  );
  await assert.rejects(publishRelease({ ...options, manifestSha256, execute }), /integrity/i);
  assert.equal(uploaded, false);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[1].status, "failed");
  assert.equal(outcomes.packages[1].reason, "integrity_mismatch");
});

test("registry network failure remains unknown and never becomes permission to publish", async (t) => {
  const { options, manifestSha256 } = await packedFixture(t);
  let uploaded = false;
  const execute = registryExecutor(
    options,
    async () => {
      throw new Error("Network timeout");
    },
    async () => {
      uploaded = true;
    },
  );
  await assert.rejects(publishRelease({ ...options, manifestSha256, execute }), /unknown/i);
  assert.equal(uploaded, false);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "unknown");
});

test("matching registry metadata with an unavailable served tarball remains unknown", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  let uploaded = false;
  const execute = registryExecutor(
    options,
    async () => manifest.packages[0].integrity,
    async () => {
      uploaded = true;
    },
  );
  await assert.rejects(
    publishRelease({
      ...options,
      manifestSha256,
      execute,
      download: async () => {
        throw new Error("Registry tarball request timed out");
      },
    }),
    /unknown/i,
  );
  assert.equal(uploaded, false);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "unknown");
});

test("publication stops after an upload whose served bytes do not match the retained tarball", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async () => {
      if (uploads === 0) throw missingVersion();
      return manifest.packages[0].integrity;
    },
    async () => {
      uploads++;
      return { stdout: "accepted" };
    },
  );
  await assert.rejects(
    publishRelease({ ...options, manifestSha256, execute, download: async () => Buffer.from("different bytes") }),
    /registry_bytes_mismatch/i,
  );
  assert.equal(uploads, 1);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "failed");
  assert.equal(outcomes.packages[0].reason, "registry_bytes_mismatch");
  assert.equal(outcomes.packages[1].status, "missing");
});

test("an upload timeout reconciles accepted bytes and resumes without publishing them twice", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  const registry = new Map();
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async (name) => {
      if (!registry.has(name)) throw missingVersion();
      return registry.get(name);
    },
    async (args) => {
      const entry = manifest.packages.find((entry) => join(options.directory, entry.filename) === args[1]);
      registry.set(`${entry.name}@${entry.version}`, entry.integrity);
      uploads++;
      if (uploads === 1) throw new Error("Upload response timed out after acceptance");
      return { stdout: "published" };
    },
  );
  const outcomes = await publishRelease({ ...options, manifestSha256, execute });
  assert.equal(uploads, 2);
  assert.equal(outcomes.packages[0].action, "reconciled_after_error");
  assert.ok(outcomes.packages.every((entry) => entry.status === "verified_published"));
});

test("an unconfirmed upload stops with a persisted unknown outcome", async (t) => {
  const { options, manifestSha256 } = await packedFixture(t);
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async () => {
      throw missingVersion();
    },
    async () => {
      uploads++;
      throw new Error("Upload timed out");
    },
  );
  await assert.rejects(
    publishRelease({ ...options, manifestSha256, execute, reconciliationTimeoutMs: 0 }),
    /unconfirmed/i,
  );
  assert.equal(uploads, 1);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "unknown");
  assert.equal(outcomes.packages[0].reason, "publish_unconfirmed");
});

function reconciliationClock() {
  let elapsed = 0;
  const waits = [];
  return {
    now: () => elapsed,
    advance: (duration) => {
      elapsed += duration;
    },
    waits,
    wait: async (duration) => {
      waits.push(duration);
      elapsed += duration;
    },
  };
}

for (const uploadFails of [false, true]) {
  test(`a ${uploadFails ? "timed-out" : "successful"} upload waits for registry visibility without uploading again`, async (t) => {
    const { options, manifest, manifestSha256 } = await packedFixture(t);
    const clock = reconciliationClock();
    let uploads = 0;
    let readsAfterUpload = 0;
    const execute = registryExecutor(
      options,
      async (name) => {
        if (name.startsWith("@agentium/harness@")) return manifest.packages[1].integrity;
        if (!uploads || ++readsAfterUpload < 3) throw missingVersion();
        return manifest.packages[0].integrity;
      },
      async () => {
        uploads++;
        if (uploadFails) throw new Error("Upload response timed out after acceptance");
        return { stdout: "accepted" };
      },
    );
    const outcomes = await publishRelease({ ...options, manifestSha256, execute, ...clock });
    assert.equal(uploads, 1);
    assert.equal(readsAfterUpload, 3);
    assert.equal(clock.waits.length, 2);
    assert.ok(outcomes.packages.every((entry) => entry.status === "verified_published"));
    assert.equal(outcomes.packages[0].action, uploadFails ? "reconciled_after_error" : "published");
    assert.equal(outcomes.packages[1].action, "already_present");
    assert.deepEqual(JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8")), outcomes);
  });
}

test("registry visibility reconciliation expires at its default monotonic deadline without another upload", async (t) => {
  const { options, manifestSha256 } = await packedFixture(t);
  const clock = reconciliationClock();
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async () => {
      throw missingVersion();
    },
    async () => {
      uploads++;
      return { stdout: "accepted" };
    },
  );
  await assert.rejects(
    publishRelease({ ...options, manifestSha256, execute, ...clock, reconciliationIntervalMs: 70_000 }),
    /publication_missing/i,
  );
  assert.equal(uploads, 1);
  assert.deepEqual(clock.waits, [70_000, 70_000, 40_000]);
  assert.equal(clock.now(), 180_000);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "failed");
  assert.equal(outcomes.packages[0].reason, "publication_missing");
  assert.equal(outcomes.packages[1].status, "missing");
});

test("an upload with an uncertain response remains unknown when visibility reconciliation expires", async (t) => {
  const { options, manifestSha256 } = await packedFixture(t);
  const clock = reconciliationClock();
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async () => {
      throw missingVersion();
    },
    async () => {
      uploads++;
      throw new Error("Upload response timed out");
    },
  );
  await assert.rejects(
    publishRelease({
      ...options,
      manifestSha256,
      execute,
      ...clock,
      reconciliationTimeoutMs: 5,
      reconciliationIntervalMs: 3,
    }),
    /publish_unconfirmed/i,
  );
  assert.equal(uploads, 1);
  assert.deepEqual(clock.waits, [3, 2]);
  const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
  assert.equal(outcomes.packages[0].status, "unknown");
  assert.equal(outcomes.packages[0].reason, "publish_unconfirmed");
});

for (const registryFailure of ["mismatch", "unknown"]) {
  test(`registry visibility polling halts on ${registryFailure} without retrying upload`, async (t) => {
    const { options, manifestSha256 } = await packedFixture(t);
    const clock = reconciliationClock();
    let uploads = 0;
    let readsAfterUpload = 0;
    const execute = registryExecutor(
      options,
      async () => {
        if (!uploads || ++readsAfterUpload < 2) throw missingVersion();
        if (registryFailure === "unknown") throw new Error("Registry request failed");
        return "sha512-different";
      },
      async () => {
        uploads++;
        return { stdout: "accepted" };
      },
    );
    await assert.rejects(
      publishRelease({ ...options, manifestSha256, execute, ...clock }),
      registryFailure === "mismatch" ? /integrity_mismatch/i : /registry_unavailable/i,
    );
    assert.equal(uploads, 1);
    assert.equal(readsAfterUpload, 2);
    assert.equal(clock.waits.length, 1);
    const outcomes = JSON.parse(await readFile(join(options.directory, "outcomes.json"), "utf8"));
    assert.equal(outcomes.packages[0].status, registryFailure === "mismatch" ? "failed" : "unknown");
    assert.equal(outcomes.packages[1].status, "missing");
  });
}

test("registry reads use the remaining reconciliation budget instead of extending the deadline", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  const clock = reconciliationClock();
  let uploads = 0;
  let readsAfterUpload = 0;
  const readTimeouts = [];
  const downloadTimeouts = [];
  const registryExecute = registryExecutor(
    options,
    async (name) => {
      if (name.startsWith("@agentium/core@")) return manifest.packages[0].integrity;
      if (!uploads) throw missingVersion();
      if (++readsAfterUpload === 1) {
        clock.advance(300);
        throw missingVersion();
      }
      return manifest.packages[1].integrity;
    },
    async () => {
      uploads++;
      return { stdout: "accepted" };
    },
  );
  const execute = async (command, args, executionOptions) => {
    if (command === "npm" && args[0] === "view" && uploads) readTimeouts.push(executionOptions.timeout);
    return registryExecute(command, args, executionOptions);
  };
  const outcomes = await publishRelease({
    ...options,
    manifestSha256,
    execute,
    ...clock,
    reconciliationTimeoutMs: 1_000,
    reconciliationIntervalMs: 500,
    download: async (url, _size, timeoutMs) => {
      if (uploads) downloadTimeouts.push(timeoutMs);
      return options.download(url);
    },
  });
  assert.equal(uploads, 1);
  assert.deepEqual(clock.waits, [500]);
  assert.deepEqual(readTimeouts, [1_000, 200]);
  assert.deepEqual(downloadTimeouts, [200]);
  assert.ok(outcomes.packages.every((entry) => entry.status === "verified_published"));
});

test("release CLI accepts an explicitly bounded registry reconciliation deadline", async () => {
  const script = fileURLToPath(new URL("./release-artifacts.mjs", import.meta.url));
  await assert.rejects(
    exec(process.execPath, [script, "publish", "--reconciliation-timeout-ms", "600000"]),
    (error) => error.code === 1 && /Publication requires the source ref/.test(error.stderr),
  );
});

test("release command deadlines reject unbounded, noninteger and nonpositive values", () => {
  assert.deepEqual(parseReleaseOptions([], "/release"), { root: "/release" });
  for (const value of ["1", "180000", "600000"]) {
    assert.equal(parseReleaseOptions(["--reconciliation-timeout-ms", value]).reconciliationTimeoutMs, Number(value));
  }
  for (const value of ["0", "-1", "1.5", "600001", "Infinity", "NaN", "1e5", "0x10", "9007199254740993"]) {
    assert.throws(parseReleaseOptions.bind(null, ["--reconciliation-timeout-ms", value]), /positive integer.*600000/);
  }
  assert.throws(parseReleaseOptions.bind(null, ["--reconciliation-timeout-ms"]), /Invalid.*arguments/);
  assert.throws(parseReleaseOptions.bind(null, ["--reconciliation-timeout-ms", ""]), /Invalid.*arguments/);
  assert.throws(parseReleaseOptions.bind(null, ["--unknown", "600000"]), /Invalid.*arguments/);
});

test("an operator-selected deadline reconciles visibility beyond three minutes with only one upload", async (t) => {
  const { options, manifest, manifestSha256 } = await packedFixture(t);
  const clock = reconciliationClock();
  let uploads = 0;
  const execute = registryExecutor(
    options,
    async (name) => {
      if (name.startsWith("@agentium/harness@")) return manifest.packages[1].integrity;
      if (!uploads || clock.now() < 240_000) throw missingVersion();
      return manifest.packages[0].integrity;
    },
    async () => {
      uploads++;
      return { stdout: "accepted" };
    },
  );
  const outcomes = await publishRelease({
    ...options,
    ...parseReleaseOptions(["--reconciliation-timeout-ms", "600000"], options.root),
    manifestSha256,
    execute,
    ...clock,
    reconciliationIntervalMs: 120_000,
  });
  assert.equal(uploads, 1);
  assert.deepEqual(clock.waits, [120_000, 120_000]);
  assert.equal(clock.now(), 240_000);
  assert.ok(outcomes.packages.every((entry) => entry.status === "verified_published"));
  assert.equal(outcomes.packages[0].action, "published");
});
