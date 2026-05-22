import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export interface RedisStorageConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  url?: string;
  keyPrefix?: string;
  ttl?: number;
}

export class RedisStorage implements StorageDriver {
  private client: any;
  private keyPrefix: string;
  private ttl: number | null;

  constructor(private config: RedisStorageConfig = {}) {
    this.keyPrefix = config.keyPrefix ?? "agentium";
    this.ttl = config.ttl ?? null;

    let Redis: any;
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
    return `${this.keyPrefix}:${namespace}:${key}`;
  }

  private makeScanPattern(namespace: string, prefix?: string): string {
    return prefix ? `${this.keyPrefix}:${namespace}:${prefix}*` : `${this.keyPrefix}:${namespace}:*`;
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
    const nsPrefix = `${this.keyPrefix}:${namespace}:`;
    const results: Array<{ key: string; value: T }> = [];

    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await this.client.mget(...keys);
        for (let i = 0; i < keys.length; i++) {
          if (values[i] !== null) {
            results.push({
              key: (keys[i] as string).slice(nsPrefix.length),
              value: JSON.parse(values[i] as string) as T,
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
