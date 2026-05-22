#!/usr/bin/env node

/**
 * Agentium Release Script
 *
 * Bumps version across all packages, commits, creates a git tag, and pushes.
 * GitHub Actions handles npm publish and GitHub Release creation on tag push.
 *
 * Usage:
 *   npm run release -- patch          # 0.3.8 → 0.3.9
 *   npm run release -- minor          # 0.3.8 → 0.4.0
 *   npm run release -- major          # 0.3.8 → 1.0.0
 *   npm run release -- 0.5.0          # explicit version
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const PACKAGES = [
  "package.json",
  "packages/core/package.json",
  "packages/transport/package.json",
  "packages/queue/package.json",
  "packages/browser/package.json",
  "packages/admin/package.json",
  "packages/edge/package.json",
  "packages/eval/package.json",
  "packages/observability/package.json",
];

const PEER_DEP_FILES = [
  "packages/transport/package.json",
  "packages/queue/package.json",
  "packages/browser/package.json",
  "packages/admin/package.json",
  "packages/edge/package.json",
  "packages/eval/package.json",
  "packages/observability/package.json",
];

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function runQuiet(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf-8" }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf-8"));
}

function writeJson(path, data) {
  writeFileSync(resolve(root, path), `${JSON.stringify(data, null, 2)}\n`);
}

function bumpVersion(current, bump) {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
      console.error(`Invalid version bump: ${bump}`);
      process.exit(1);
  }
}

// ── Preflight checks ────────────────────────────────────────────────────

const status = runQuiet("git status --porcelain");
if (status) {
  console.error("\n❌ Working directory is not clean. Commit or stash changes first.\n");
  console.error(status);
  process.exit(1);
}

const args = process.argv.slice(2);
const bump = args[0] || "patch";

const currentVersion = readJson("package.json").version;
const newVersion = bumpVersion(currentVersion, bump);
const tag = `v${newVersion}`;

console.log(`\n📦 Agentium Release: ${currentVersion} → ${newVersion}\n`);

// 1. Update versions
console.log("1️⃣  Updating versions...");
for (const pkg of PACKAGES) {
  const json = readJson(pkg);
  json.version = newVersion;
  writeJson(pkg, json);
  console.log(`   ✅ ${pkg} → ${newVersion}`);
}

// 2. Update peer dependency on @agentium/core
for (const pkg of PEER_DEP_FILES) {
  const json = readJson(pkg);
  if (json.peerDependencies?.["@agentium/core"]) {
    json.peerDependencies["@agentium/core"] = `^${newVersion}`;
    writeJson(pkg, json);
    console.log(`   ✅ ${pkg} peer dep @agentium/core → ^${newVersion}`);
  }
}

// 3. Build to verify everything compiles
console.log("\n2️⃣  Building all packages...");
run("npm run build");

// 4. Commit version bump
console.log("\n3️⃣  Committing version bump...");
run("git add -A");
run(`git commit -m "release: ${tag}"`);

// 5. Create annotated tag
console.log(`\n4️⃣  Creating tag ${tag}...`);
run(`git tag -a ${tag} -m "Release ${tag}"`);

// 6. Push commit and tag
console.log("\n5️⃣  Pushing to remote...");
run("git push");
run("git push --tags");

console.log(`\n✅ Released ${tag} — GitHub Actions will publish to npm and create the release.\n`);
