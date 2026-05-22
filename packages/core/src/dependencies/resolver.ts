export type DependencyValue = unknown | (() => unknown) | (() => Promise<unknown>);
export type DependencyMap = Record<string, DependencyValue>;

/**
 * Resolve all dependencies — calls any callable values and awaits promises.
 * Returns a flat Record<string, string> suitable for template substitution.
 */
export async function resolveDependencies(deps: DependencyMap): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const entries = Object.entries(deps);

  const results = await Promise.allSettled(
    entries.map(async ([key, value]) => {
      const resolved = typeof value === "function" ? await (value as () => unknown)() : value;
      return { key, value: String(resolved ?? "") };
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      resolved[result.value.key] = result.value.value;
    }
  }

  return resolved;
}

/**
 * Replace `{key}` placeholders in text with resolved dependency values.
 * Only replaces keys that exist in the resolved map — unknown placeholders are left as-is.
 */
export function applyTemplates(text: string, resolved: Record<string, string>): string {
  if (!text || Object.keys(resolved).length === 0) return text;

  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in resolved ? resolved[key] : match;
  });
}
