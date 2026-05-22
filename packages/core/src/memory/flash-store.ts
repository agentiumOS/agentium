import { createRequire } from "node:module";
import type { StorageDriver } from "../storage/driver.js";

const _require = createRequire(import.meta.url);

export interface FlashMemoryStoreConfig {
  /**
   * Path to the LMDB database directory (required when LMDB backend is desired).
   * If `lmdb` is not installed or `path` is omitted, the store falls back to
   * pure in-memory operation.
   */
  path?: string;
  /** Maximum size of the LMDB store in bytes. Default: 2 GB. */
  mapSize?: number;
  /** Maximum entries kept in the hot in-memory tier. Default: 10_000. */
  hotCacheSize?: number;
}

interface CacheEntry {
  value: unknown;
  hits: number;
  lastAccess: number;
}

/**
 * Tiered "flash" memory store implementing `StorageDriver`.
 *
 * - Hot tier: in-process Map, evicted by access frequency
 * - Cold tier: LMDB on disk (if `lmdb` peer dep installed), else pure in-memory fallback
 *
 * Inspired by Redis Flex - keeps 99% of data on flash and the hot working set in memory.
 */
export class FlashMemoryStore implements StorageDriver {
  private hot = new Map<string, CacheEntry>();
  private cold: any = null;
  private hotCacheSize: number;

  constructor(config: FlashMemoryStoreConfig = {}) {
    this.hotCacheSize = config.hotCacheSize ?? 10_000;

    if (config.path) {
      try {
        const lmdb = _require("lmdb");
        this.cold = lmdb.open({
          path: config.path,
          mapSize: config.mapSize ?? 2 * 1024 * 1024 * 1024,
          compression: true,
        });
      } catch (e: any) {
        if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
          // Soft-fall back to in-memory.
          console.warn(
            "[agentium/flash-memory] `lmdb` not installed - falling back to pure in-memory storage. Install with: npm install lmdb",
          );
          this.cold = null;
        } else {
          throw e;
        }
      }
    }
  }

  private key(ns: string, k: string): string {
    return `${ns}\u0000${k}`;
  }

  async initialize(): Promise<void> {
    // LMDB opens lazily on first access; nothing to do here.
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const fullKey = this.key(namespace, key);
    const cached = this.hot.get(fullKey);
    if (cached) {
      cached.hits += 1;
      cached.lastAccess = Date.now();
      return cached.value as T;
    }
    if (this.cold) {
      const value = this.cold.get(fullKey);
      if (value !== undefined) {
        this.promoteToHot(fullKey, value);
        return value as T;
      }
    }
    return null;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const fullKey = this.key(namespace, key);
    if (this.cold) {
      await this.cold.put(fullKey, value);
    }
    this.promoteToHot(fullKey, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    const fullKey = this.key(namespace, key);
    this.hot.delete(fullKey);
    if (this.cold) {
      await this.cold.remove(fullKey);
    }
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const seenKeys = new Set<string>();
    const out: Array<{ key: string; value: T }> = [];
    const nsPrefix = `${namespace}\u0000${prefix ?? ""}`;

    if (this.cold) {
      for (const { key, value } of this.cold.getRange({ start: nsPrefix })) {
        const k = String(key);
        if (!k.startsWith(nsPrefix)) break;
        const innerKey = k.slice(namespace.length + 1);
        seenKeys.add(k);
        out.push({ key: innerKey, value: value as T });
      }
    }

    // Include any hot-only entries (e.g. cold was never configured, or recently set in-mem before being flushed).
    for (const [k, entry] of this.hot.entries()) {
      if (!k.startsWith(nsPrefix) || seenKeys.has(k)) continue;
      const innerKey = k.slice(namespace.length + 1);
      out.push({ key: innerKey, value: entry.value as T });
    }
    return out;
  }

  async close(): Promise<void> {
    this.hot.clear();
    if (this.cold) await this.cold.close();
  }

  private promoteToHot(fullKey: string, value: unknown): void {
    const existing = this.hot.get(fullKey);
    if (existing) {
      existing.value = value;
      existing.hits += 1;
      existing.lastAccess = Date.now();
    } else {
      if (this.hot.size >= this.hotCacheSize) {
        this.evict();
      }
      this.hot.set(fullKey, { value, hits: 1, lastAccess: Date.now() });
    }
  }

  /**
   * Evict the lowest-frequency entry from the hot tier. (Approximate LFU.)
   * Ties broken by oldest last-access.
   */
  private evict(): void {
    let worstKey: string | null = null;
    let worstHits = Number.POSITIVE_INFINITY;
    let worstAccess = Number.POSITIVE_INFINITY;
    for (const [k, e] of this.hot.entries()) {
      if (e.hits < worstHits || (e.hits === worstHits && e.lastAccess < worstAccess)) {
        worstKey = k;
        worstHits = e.hits;
        worstAccess = e.lastAccess;
      }
    }
    if (worstKey) this.hot.delete(worstKey);
  }
}
