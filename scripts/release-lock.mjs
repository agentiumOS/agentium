/** Update only release metadata, preserving every locked dependency and platform binding. */
export function syncReleaseLock(lock, manifests) {
  if (lock.lockfileVersion < 2 || !lock.packages || !manifests[""])
    throw new Error("Release requires a workspace lockfile and root manifest");
  const updated = structuredClone(lock);
  updated.version = manifests[""].version;
  for (const [path, manifest] of Object.entries(manifests)) {
    const entry = updated.packages[path];
    if (!entry) throw new Error(`Workspace is missing from package-lock.json: ${path || "root"}`);
    entry.version = manifest.version;
    if (manifest.peerDependencies) entry.peerDependencies = { ...manifest.peerDependencies };
    else delete entry.peerDependencies;
  }
  return updated;
}
