import type { StorageDriver } from "./driver.js";

export class InMemoryStorage implements StorageDriver {
  private store = new Map<string, string>();

  private makeKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const raw = this.store.get(this.makeKey(namespace, key));
    if (raw === undefined) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    this.store.set(this.makeKey(namespace, key), JSON.stringify(value));
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.store.delete(this.makeKey(namespace, key));
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const nsPrefix = prefix ? `${namespace}:${prefix}` : `${namespace}:`;
    const results: Array<{ key: string; value: T }> = [];

    for (const [fullKey, raw] of this.store.entries()) {
      if (fullKey.startsWith(nsPrefix)) {
        const key = fullKey.slice(namespace.length + 1);
        results.push({ key, value: JSON.parse(raw) as T });
      }
    }

    return results;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
