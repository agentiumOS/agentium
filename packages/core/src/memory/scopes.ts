export interface MemoryScope {
  path: string;
}

/**
 * Returns true if `parent` is an ancestor of (or equal to) `child` in
 * a hierarchical "/" separated namespace.
 *
 * isAncestor("org", "org/team/project") → true
 * isAncestor("org/team", "org/other") → false
 */
export function isAncestor(parent: string, child: string): boolean {
  if (parent === child) return true;
  const normalized = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalized);
}

/**
 * Expand a scope path into all ancestor paths (inclusive).
 *
 * resolveScope("org/team/project") → ["org", "org/team", "org/team/project"]
 */
export function resolveScope(scope: string): string[] {
  const parts = scope.split("/").filter(Boolean);
  const paths: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    paths.push(parts.slice(0, i).join("/"));
  }
  return paths;
}

/**
 * Check whether a stored namespace matches a query scope —
 * a stored item at "org/team" is visible to queries for "org/team" or "org/team/project".
 */
export function scopeMatches(storedScope: string, queryScope: string): boolean {
  return isAncestor(storedScope, queryScope);
}
