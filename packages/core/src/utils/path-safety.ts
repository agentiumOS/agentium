import { sep as PATH_SEP, resolve as resolvePath } from "node:path";

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
  if (target !== base && !target.startsWith(base + PATH_SEP)) {
    throw new PathSecurityError(`Path traversal blocked: ${relPath} resolves outside ${baseDir}`);
  }
  return target;
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
