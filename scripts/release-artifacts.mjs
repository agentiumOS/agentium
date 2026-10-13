#!/usr/bin/env node

// Keep release checks and publication bound to retained npm tarball bytes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const registry = "https://registry.npmjs.org";
const manifestFields = [
  "name",
  "version",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
  "exports",
  "main",
  "module",
  "types",
  "bin",
  "files",
  "scripts",
];

function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

function packageContract(metadata) {
  return Object.fromEntries(
    manifestFields.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]),
  );
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function run(execute, root, command, args, timeout = 60_000) {
  return execute(command, args, { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024 });
}

function releaseVersion(tag) {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(
      tag ?? "",
    );
  assert.ok(
    match && !match[2]?.split(".").some((part) => /^0\d+$/.test(part)),
    "Release tag must be v followed by a valid semantic version",
  );
  return match[1];
}

async function metadata(root, expectedVersion) {
  const rootPackage = await json(join(root, "package.json"));
  const version = expectedVersion ?? rootPackage.version;
  releaseVersion(`v${version}`);
  assert.equal(rootPackage.version, version, "Root version does not match release version");
  assert.ok(
    Array.isArray(rootPackage.workspaces) && rootPackage.workspaces.length,
    "Release requires explicit workspace paths",
  );
  const packages = await Promise.all(
    rootPackage.workspaces.map(async (workspace) => {
      assert.ok(
        typeof workspace === "string" && !isAbsolute(workspace) && !workspace.split(/[\\/]/).includes(".."),
        "Invalid release workspace path",
      );
      const pkg = await json(join(root, workspace, "package.json"));
      assert.equal(pkg.version, version, `${workspace}: workspace version does not match release version`);
      assert.ok(!pkg.private, `${workspace}: release workspace is private`);
      return { workspace, metadata: pkg };
    }),
  );
  assert.equal(
    new Set(packages.map((pkg) => pkg.metadata.name)).size,
    packages.length,
    "Duplicate release package name",
  );
  const lock = await json(join(root, "package-lock.json"));
  assert.equal(lock.version, version, "Root lockfile version does not match release version");
  for (const [workspace, pkg] of [["", rootPackage], ...packages.map((pkg) => [pkg.workspace, pkg.metadata])]) {
    const entry = lock.packages?.[workspace];
    assert.equal(entry?.version, version, `${workspace || "root"}: lockfile version does not match release version`);
    assert.deepEqual(
      entry.peerDependencies,
      pkg.peerDependencies,
      `${workspace || "root"}: lockfile peer dependencies do not match`,
    );
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (packages.some((candidate) => candidate.metadata.name === name))
        assert.equal(range, `^${version}`, `${workspace}: internal peer version does not match release version`);
    }
  }
  return { version, packages };
}

async function sourceIdentity(root, execute, expectedRef) {
  const sha = (await run(execute, root, "git", ["rev-parse", "HEAD"])).stdout.trim();
  assert.match(sha, /^[a-f0-9]{40,64}$/, "Invalid source commit identity");
  if (expectedRef) assert.equal(sha, expectedRef, "Source commit does not match requested release ref");
  const names = (
    await run(execute, root, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  ).stdout
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const name of names) {
    digest.update(`${name}\0`);
    digest.update(await readFile(join(root, name)));
    digest.update("\0");
  }
  return {
    sha,
    fingerprint: digest.digest("hex"),
    lockfileSha256: hash(await readFile(join(root, "package-lock.json"))),
    dirty: Boolean(
      (await run(execute, root, "git", ["status", "--porcelain", "--untracked-files=normal"])).stdout.trim(),
    ),
  };
}

export async function preflightRelease({ root = process.cwd(), tag, ref, execute = exec }) {
  const version = releaseVersion(tag);
  const sha = (await run(execute, root, "git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])).stdout.trim();
  if (ref) assert.equal(sha, ref, "Release tag does not match expected source commit");
  const source = await sourceIdentity(root, execute, sha);
  assert.equal(source.dirty, false, "Release tag checkout must have clean source inputs");
  await metadata(root, version);
  return { sha, version, tag };
}

function artifactPath(directory, filename) {
  assert.ok(
    typeof filename === "string" && filename.endsWith(".tgz") && basename(filename) === filename,
    "Invalid release tarball filename",
  );
  return join(directory, filename);
}

async function inspectTarball(root, execute, path, entry, expectedMetadata) {
  assert.ok(Array.isArray(expectedMetadata.files), `${entry.name}: distribution must declare allowed files`);
  for (const file of entry.files) {
    const name = file.path;
    assert.ok(
      typeof name === "string" && !isAbsolute(name) && !name.includes("\\") && !name.split("/").includes(".."),
      `${entry.name}: unsafe packed path`,
    );
    assert.ok(
      !/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.npmrc|credentials(?:\.[^/]*)?|id_(?:rsa|ed25519)|__tests__|fixtures)(?:\/|$)|\.(?:pem|key)$/i.test(
        name,
      ),
      `${entry.name}: prohibited credential or fixture file category`,
    );
    const automatic =
      /^(?:package\.json|README(?:\.[^/]+)?|LICEN[CS]E(?:\.[^/]+)?|NOTICE(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?)$/i.test(
        name,
      );
    assert.ok(
      automatic ||
        expectedMetadata.files.some((allowed) => name === allowed || name.startsWith(`${allowed.replace(/\/$/, "")}/`)),
      `${entry.name}: packed file is outside declared distribution roots`,
    );
    if (name.endsWith(".map")) {
      assert.match(name, /\.d\.(?:ts|cts)\.map$/, `${entry.name}: runtime source maps are not allowed`);
      const map = JSON.parse((await run(execute, root, "tar", ["-xOf", path, `package/${name}`])).stdout);
      assert.equal(map.version, 3, `${entry.name}: unsupported declaration map version`);
      assert.ok(
        map.sourcesContent === undefined ||
          (Array.isArray(map.sourcesContent) && map.sourcesContent.every((content) => content === null)),
        `${entry.name}: declaration map contains embedded source content`,
      );
      const relativeMapPath = (reference) =>
        typeof reference === "string" &&
        !posix.isAbsolute(reference) &&
        !reference.includes("\\") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(reference);
      const sourceRoot = map.sourceRoot ?? "";
      assert.ok(
        relativeMapPath(sourceRoot) && Array.isArray(map.sources),
        `${entry.name}: unsafe source path in declaration map`,
      );
      for (const source of map.sources) {
        assert.ok(relativeMapPath(source), `${entry.name}: unsafe source path in declaration map`);
        const sourcePath = posix.normalize(posix.join(posix.dirname(name), sourceRoot, source));
        assert.ok(
          sourcePath !== ".." && !sourcePath.startsWith("../"),
          `${entry.name}: unsafe source path outside the package in declaration map`,
        );
      }
    }
  }
  const packed = JSON.parse((await run(execute, root, "tar", ["-xOf", path, "package/package.json"])).stdout);
  assert.deepEqual(
    stable(packageContract(packed)),
    stable(packageContract(expectedMetadata)),
    `${entry.name}: packed package metadata does not match source`,
  );
  const files = (await run(execute, root, "tar", ["-tzf", path])).stdout
    .trim()
    .split("\n")
    .filter((file) => !file.endsWith("/"));
  assert.deepEqual(
    files.sort(),
    entry.files.map((file) => `package/${file.path}`).sort(),
    `${entry.name}: packed file inventory does not match`,
  );
}

export async function packRelease({ root = process.cwd(), directory, ref, execute = exec }) {
  assert.ok(directory, "Release artifact directory is required");
  directory = resolve(directory);
  const artifactRelativePath = relative(root, directory);
  assert.ok(
    artifactRelativePath === ".." || artifactRelativePath.startsWith(`..${sep}`) || isAbsolute(artifactRelativePath),
    "Retain release artifacts outside the source checkout",
  );
  const release = await metadata(root);
  const source = await sourceIdentity(root, execute, ref);
  assert.equal(source.dirty, false, "Release artifact packing requires clean source inputs");
  await mkdir(directory, { recursive: true });
  const packages = [];
  // Older npm/pacote runs prepare even with --ignore-scripts; fail before any pack.
  assert.ok(
    release.packages.every((pkg) => !pkg.metadata.scripts?.prepare),
    "Workspace prepare hooks cannot preserve release artifact identity; build explicitly before packing",
  );
  for (const pkg of release.packages) {
    const output = await run(execute, join(root, pkg.workspace), "npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      directory,
    ]);
    const [packed] = JSON.parse(output.stdout);
    assert.equal(packed.name, pkg.metadata.name, "Packed package name does not match source");
    assert.equal(packed.version, release.version, "Packed package version does not match release");
    const path = artifactPath(directory, packed.filename);
    const bytes = await readFile(path);
    const integrity = `sha512-${hash(bytes, "sha512", "base64")}`;
    assert.equal(packed.integrity, integrity, "npm pack integrity does not match retained bytes");
    const entry = {
      workspace: pkg.workspace,
      name: packed.name,
      version: packed.version,
      filename: packed.filename,
      sha256: hash(bytes),
      integrity,
      shasum: hash(bytes, "sha1"),
      size: bytes.length,
      metadata: packageContract(pkg.metadata),
      files: packed.files,
    };
    await inspectTarball(root, execute, path, entry, pkg.metadata);
    packages.push(entry);
  }
  assert.deepEqual(
    await sourceIdentity(root, execute, ref),
    source,
    "Source inputs changed while packing release artifacts",
  );
  const manifest = {
    schemaVersion: 1,
    version: release.version,
    source,
    toolchain: {
      node: process.version,
      npm: (await run(execute, root, "npm", ["--version"])).stdout.trim(),
      platform: platform(),
      arch: arch(),
    },
    packages,
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, "manifest.json"), bytes);
  return { manifest, manifestSha256: hash(bytes) };
}

export async function verifyRelease({ root = process.cwd(), directory, ref, version, manifestSha256, execute = exec }) {
  assert.ok(directory, "Release artifact directory is required");
  directory = resolve(directory);
  const bytes = await readFile(join(directory, "manifest.json"));
  const digest = hash(bytes);
  if (manifestSha256)
    assert.equal(digest, manifestSha256, "Retained manifest hash does not match verified CI manifest");
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unknown release artifact manifest version");
  const release = await metadata(root, version ?? manifest.version);
  assert.equal(manifest.version, release.version, "Artifact version does not match release version");
  assert.deepEqual(
    await sourceIdentity(root, execute, ref),
    manifest.source,
    "Retained artifact source identity does not match checkout inputs",
  );
  assert.deepEqual(
    manifest.packages.map((pkg) => [pkg.workspace, pkg.name, pkg.version]),
    release.packages.map((pkg) => [pkg.workspace, pkg.metadata.name, release.version]),
    "Retained package list does not match release workspaces",
  );
  assert.equal(
    new Set(manifest.packages.map((pkg) => pkg.filename)).size,
    manifest.packages.length,
    "Duplicate retained tarball filename",
  );
  for (const [index, entry] of manifest.packages.entries()) {
    const path = artifactPath(directory, entry.filename);
    const tarball = await readFile(path);
    assert.equal(hash(tarball), entry.sha256, `${entry.name}: retained tarball bytes changed`);
    assert.equal(
      `sha512-${hash(tarball, "sha512", "base64")}`,
      entry.integrity,
      `${entry.name}: retained integrity does not match bytes`,
    );
    assert.equal(hash(tarball, "sha1"), entry.shasum, `${entry.name}: retained shasum does not match bytes`);
    assert.equal(tarball.length, entry.size, `${entry.name}: retained size does not match bytes`);
    assert.deepEqual(
      stable(entry.metadata),
      stable(packageContract(release.packages[index].metadata)),
      `${entry.name}: retained package metadata changed`,
    );
    await inspectTarball(root, execute, path, entry, release.packages[index].metadata);
  }
  return { manifest, manifestSha256: digest };
}

function npmErrorCode(error) {
  for (const output of [error.stdout, error.stderr]) {
    try {
      const value = JSON.parse(output);
      if (typeof value?.error?.code === "string") return value.error.code;
    } catch {
      /* Unparseable command output cannot prove that a version is absent. */
    }
  }
  return undefined;
}

async function downloadTarball(url, size, timeoutMs = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.ceil(timeoutMs)), redirect: "error" });
  assert.ok(response.ok && response.body, "Registry tarball retrieval failed");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > size)
        throw Object.assign(new Error("Registry tarball exceeded retained size"), { code: "ARTIFACT_TOO_LARGE" });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function registryState(root, execute, entry, download, remainingMs = () => Infinity) {
  try {
    const lookupTimeoutMs = Math.ceil(Math.min(60_000, remainingMs()));
    if (lookupTimeoutMs <= 0) return { status: "unknown", reason: "registry_unavailable" };
    const output = await run(
      execute,
      root,
      "npm",
      ["view", `${entry.name}@${entry.version}`, "dist", "--json", `--registry=${registry}`],
      lookupTimeoutMs,
    );
    const dist = JSON.parse(output.stdout);
    if (typeof dist?.integrity !== "string") return { status: "unknown", reason: "registry_integrity_unavailable" };
    if (dist.integrity !== entry.integrity) return { status: "failed", reason: "integrity_mismatch" };
    const url = new URL(dist.tarball);
    if (url.origin !== registry || url.username || url.password)
      return { status: "unknown", reason: "registry_tarball_unavailable" };
    const downloadTimeoutMs = Math.ceil(Math.min(30_000, remainingMs()));
    if (downloadTimeoutMs <= 0) return { status: "unknown", reason: "registry_unavailable" };
    const bytes = await download(url.href, entry.size, downloadTimeoutMs);
    return bytes.length === entry.size &&
      hash(bytes) === entry.sha256 &&
      `sha512-${hash(bytes, "sha512", "base64")}` === entry.integrity
      ? { status: "verified_published" }
      : { status: "failed", reason: "registry_bytes_mismatch" };
  } catch (error) {
    if (error.code === "ARTIFACT_TOO_LARGE") return { status: "failed", reason: "registry_bytes_mismatch" };
    return npmErrorCode(error) === "E404"
      ? { status: "missing" }
      : { status: "unknown", reason: "registry_unavailable" };
  }
}

export async function publishRelease(options) {
  const {
    root = process.cwd(),
    execute = exec,
    download = downloadTarball,
    reconciliationTimeoutMs = 180_000,
    reconciliationIntervalMs = 2_000,
    now = () => performance.now(),
    wait = delay,
  } = options;
  assert.ok(Number.isFinite(reconciliationTimeoutMs) && reconciliationTimeoutMs >= 0, "Invalid reconciliation timeout");
  assert.ok(
    Number.isFinite(reconciliationIntervalMs) && reconciliationIntervalMs > 0,
    "Invalid reconciliation interval",
  );
  assert.ok(options.ref && options.manifestSha256, "Publication requires the source ref and verified CI manifest hash");
  const { manifest, manifestSha256 } = await verifyRelease(options);
  const directory = resolve(options.directory);
  const outcomes = {
    schemaVersion: 1,
    source: manifest.source,
    version: manifest.version,
    manifestSha256,
    packages: manifest.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      integrity: entry.integrity,
      status: "unknown",
      reason: "not_checked",
    })),
  };
  const persist = async () => {
    await writeFile(join(directory, "outcomes.json.tmp"), `${JSON.stringify(outcomes, null, 2)}\n`);
    await rename(join(directory, "outcomes.json.tmp"), join(directory, "outcomes.json"));
  };
  await persist();
  // Reconcile every version before the first upload, preventing avoidable partial releases.
  for (const [index, entry] of manifest.packages.entries()) {
    const state = await registryState(root, execute, entry, download);
    outcomes.packages[index] = {
      ...outcomes.packages[index],
      ...state,
      reason: state.reason,
      ...(state.status === "verified_published" ? { action: "already_present" } : {}),
    };
    if (state.reason === undefined) delete outcomes.packages[index].reason;
    await persist();
    assert.ok(
      state.status === "missing" || state.status === "verified_published",
      `${entry.name}: registry state is ${state.status} (${state.reason}); publication stopped`,
    );
  }
  for (const [index, entry] of manifest.packages.entries()) {
    if (outcomes.packages[index].status === "verified_published") continue;
    outcomes.packages[index] = { ...outcomes.packages[index], status: "unknown", reason: "publish_in_progress" };
    await persist();
    let uploadFailed = false;
    try {
      await run(
        execute,
        root,
        "npm",
        [
          "publish",
          artifactPath(directory, entry.filename),
          "--ignore-scripts",
          "--access",
          "public",
          `--registry=${registry}`,
        ],
        120_000,
      );
    } catch {
      uploadFailed = true;
    }
    const deadline = now() + reconciliationTimeoutMs;
    const remainingMs = () => Math.max(0, deadline - now());
    let state = await registryState(
      root,
      execute,
      entry,
      download,
      reconciliationTimeoutMs === 0 ? undefined : remainingMs,
    );
    // An accepted upload may precede registry visibility. Poll reads only; never retry the upload here.
    while (state.status === "missing" && remainingMs() > 0) {
      outcomes.packages[index] = {
        ...outcomes.packages[index],
        status: "unknown",
        reason: "registry_visibility_pending",
      };
      await persist();
      await wait(Math.min(reconciliationIntervalMs, remainingMs()));
      if (remainingMs() <= 0) break;
      state = await registryState(root, execute, entry, download, remainingMs);
    }
    outcomes.packages[index] = {
      ...outcomes.packages[index],
      ...state,
      reason: state.reason,
      ...(state.status === "verified_published"
        ? { action: uploadFailed ? "reconciled_after_error" : "published" }
        : {}),
    };
    if (state.reason === undefined) delete outcomes.packages[index].reason;
    if (state.status === "missing")
      outcomes.packages[index] = {
        ...outcomes.packages[index],
        status: uploadFailed ? "unknown" : "failed",
        reason: uploadFailed ? "publish_unconfirmed" : "publication_missing",
      };
    await persist();
    assert.equal(
      outcomes.packages[index].status,
      "verified_published",
      `${entry.name}: publication ${outcomes.packages[index].reason ?? "unconfirmed"}; stopped for reconciliation`,
    );
  }
  return outcomes;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = { root: process.cwd() };
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(
      ["--directory", "--ref", "--version", "--tag", "--manifest-sha256"].includes(args[index]) && args[index + 1],
      "Invalid release artifact command arguments",
    );
    options[args[index].slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase())] = args[index + 1];
  }
  const commands = { preflight: preflightRelease, pack: packRelease, verify: verifyRelease, publish: publishRelease };
  assert.ok(Object.hasOwn(commands, command), "Use preflight, pack, verify or publish");
  const result = await commands[command](options);
  const outputs =
    command === "preflight"
      ? result
      : { manifest_sha256: result.manifestSha256, version: result.manifest?.version ?? result.version };
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(JSON.stringify(command === "publish" ? result : outputs, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
