import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";
import { decodeKeySegment, encodeKeySegment } from "./key-codec.js";

const _require = createRequire(import.meta.url);

export interface RedisStorageConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  url?: string;
  keyPrefix?: string;
  ttl?: number;
  /** Defaults to legacy; tuple-v1 requires explicit migration and never reads legacy keys. */
  keyEncoding?: "legacy" | "tuple-v1";
}

interface RedisClient {
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scan(cursor: string, match: string, pattern: string, count: string, size: number): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  quit(): Promise<unknown>;
}

export class RedisStorage implements StorageDriver {
  private client: RedisClient;
  private keyPrefix: string;
  private ttl: number | null;
  private keyEncoding: "legacy" | "tuple-v1";

  constructor(config: RedisStorageConfig = {}) {
    this.keyPrefix = config.keyPrefix ?? "agentium";
    this.ttl = config.ttl ?? null;
    this.keyEncoding = config.keyEncoding ?? "legacy";

    let Redis: new (...args: unknown[]) => RedisClient;
    try {
      Redis = _require("ioredis");
    } catch {
      throw new Error("ioredis is required for RedisStorage. Install it: npm install ioredis");
    }

    if (config.url) {
      this.client = new Redis(config.url);
    } else {
      this.client = new Redis({
        host: config.host ?? "localhost",
        port: config.port ?? 6379,
        password: config.password,
        db: config.db ?? 0,
      });
    }
  }

  private makeKey(namespace: string, key: string): string {
    const segment = this.keyEncoding === "tuple-v1" ? encodeKeySegment(key) : key;
    return `${this.makeNamespacePrefix(namespace)}${segment}`;
  }

  private makeNamespacePrefix(namespace: string): string {
    return this.keyEncoding === "tuple-v1"
      ? `agkv1:${encodeKeySegment(this.keyPrefix)}:${encodeKeySegment(namespace)}:`
      : `${this.keyPrefix}:${namespace}:`;
  }

  private makeScanPattern(namespace: string, prefix?: string): string {
    return `${this.makeKey(namespace, prefix ?? "")}*`;
  }

  async initialize(): Promise<void> {
    await this.client.ping();
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const raw = await this.client.get(this.makeKey(namespace, key));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const redisKey = this.makeKey(namespace, key);
    const serialized = JSON.stringify(value);
    if (this.ttl) {
      await this.client.setex(redisKey, this.ttl, serialized);
    } else {
      await this.client.set(redisKey, serialized);
    }
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.client.del(this.makeKey(namespace, key));
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const pattern = this.makeScanPattern(namespace, prefix);
    const nsPrefix = this.makeNamespacePrefix(namespace);
    const results: Array<{ key: string; value: T }> = [];

    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await this.client.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          const raw = values[i];
          if (key !== undefined && raw !== null && raw !== undefined) {
            const segment = key.slice(nsPrefix.length);
            results.push({
              key: this.keyEncoding === "tuple-v1" ? decodeKeySegment(segment) : segment,
              value: JSON.parse(raw) as T,
            });
          }
        }
      }
    } while (cursor !== "0");

    return results;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
