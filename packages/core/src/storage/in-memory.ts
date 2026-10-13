import type { StorageDriver } from "./driver.js";

export class InMemoryStorage implements StorageDriver {
  private store = new Map<string, Map<string, string>>();

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const raw = this.store.get(namespace)?.get(key);
    if (raw === undefined) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    let entries = this.store.get(namespace);
    if (!entries) {
      entries = new Map();
      this.store.set(namespace, entries);
    }
    entries.set(key, JSON.stringify(value));
  }

  async delete(namespace: string, key: string): Promise<void> {
    const entries = this.store.get(namespace);
    entries?.delete(key);
    if (entries?.size === 0) this.store.delete(namespace);
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const results: Array<{ key: string; value: T }> = [];

    for (const [key, raw] of this.store.get(namespace) ?? []) {
      if (prefix === undefined || key.startsWith(prefix)) {
        results.push({ key, value: JSON.parse(raw) as T });
      }
    }

    return results;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
