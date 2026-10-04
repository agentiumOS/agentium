import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, sep as PATH_SEP, resolve as resolvePath } from "node:path";

/**
 * Thrown when a path traversal, symlink escape, or other path-safety violation is detected.
 */
export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

/**
 * Join a base directory with a relative path, ensuring the result is contained
 * within the base directory. Detects classic traversal attempts (`../../etc/passwd`),
 * absolute-path escapes, and embedded control characters / null bytes that some
 * filesystems treat specially.
 *
 * Does NOT resolve symlinks - callers that need symlink-aware safety should use
 * `fs.realpath` after this check.
 */
export function safeJoin(baseDir: string, relPath: string): string {
  if (relPath.includes("\0")) {
    throw new PathSecurityError("Path contains null byte");
  }
  if (/[\x00-\x1f]/.test(relPath)) {
    throw new PathSecurityError("Path contains control characters");
  }

  const base = resolvePath(baseDir);
  const target = resolvePath(base, relPath);

  // Must be inside base. Add PATH_SEP to avoid `/etcfoo` matching `/etc` etc.
  const prefix = base.endsWith(PATH_SEP) ? base : base + PATH_SEP;
  if (target !== base && !target.startsWith(prefix)) {
    throw new PathSecurityError(`Path traversal blocked: ${relPath} resolves outside ${baseDir}`);
  }
  return target;
}

/** Resolve links, including the nearest existing parent of a new file.
 * This prevents static symlink escapes, not hostile concurrent filesystem replacement.
 */
export async function canonicalSafeJoin(baseDir: string, relPath: string, allowMissing = false): Promise<string> {
  const target = safeJoin(baseDir, relPath);
  const canonicalize = async (value: string, missing: boolean): Promise<string> => {
    try {
      await lstat(value);
    } catch (error) {
      if (!missing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(value);
      if (parent === value) throw error;
      return join(await canonicalize(parent, true), basename(value));
    }
    // Existing dangling links must fail rather than be mistaken for new paths.
    return realpath(value);
  };
  const base = await canonicalize(resolvePath(baseDir), allowMissing);
  const resolved = await canonicalize(target, allowMissing);
  const prefix = base.endsWith(PATH_SEP) ? base : base + PATH_SEP;
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new PathSecurityError("Path resolves outside the configured workspace");
  }
  return resolved;
}

/**
 * Returns true when a hostname (or full URL) is allowed by an allowlist.
 *
 * Allowlist entries match the hostname exactly OR as a suffix (so `*.example.com`
 * is achieved by listing `example.com` and the matcher will accept any sub-domain).
 *
 * When `allowedHosts` is `undefined` or empty, returns true (no restriction).
 */
export function isHostAllowed(urlOrHost: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;

  let host: string;
  try {
    host = new URL(urlOrHost).hostname;
  } catch {
    host = urlOrHost;
  }
  host = host.toLowerCase();

  for (const allowed of allowedHosts) {
    const a = allowed.toLowerCase();
    if (host === a) return true;
    if (host.endsWith(`.${a}`)) return true;
  }
  return false;
}

/**
 * Assert a URL's host is in the allowlist, throwing `PathSecurityError` if not.
 */
export function assertHostAllowed(url: string, allowedHosts?: string[]): void {
  if (!isHostAllowed(url, allowedHosts)) {
    throw new PathSecurityError(`Host blocked by allowedHosts policy: ${url}`);
  }
}
