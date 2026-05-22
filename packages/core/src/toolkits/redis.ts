import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface RedisConfig {
  /** Redis connection URL (default: redis://localhost:6379). Falls back to REDIS_URL env var. */
  url?: string;
  /** Key prefix for namespacing (default: ""). */
  keyPrefix?: string;
  /** Max keys to return in list operations (default 100). */
  maxKeys?: number;
}

/**
 * Redis Toolkit — get, set, delete, list, and increment keys in Redis.
 *
 * Requires the `ioredis` peer dependency.
 *
 * @example
 * ```ts
 * const redis = new RedisToolkit({ url: "redis://localhost:6379" });
 * const agent = new Agent({ tools: [...redis.getTools()] });
 * ```
 */
export class RedisToolkit extends Toolkit {
  readonly name = "redis";
  private url: string;
  private prefix: string;
  private maxKeys: number;
  private client: any;

  constructor(config: RedisConfig = {}) {
    super();
    this.url = config.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    this.prefix = config.keyPrefix ?? "";
    this.maxKeys = config.maxKeys ?? 100;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const Redis = _require("ioredis");
    this.client = new Redis(this.url);
    return this.client;
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "redis_get",
        description: "Get the value of a key from Redis.",
        parameters: z.object({
          key: z.string().describe("The key to get"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const redis = await this.getClient();
            const value = await redis.get(this.fullKey(args.key as string));
            if (value === null) return "(key not found)";
            return value;
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "redis_set",
        description: "Set a key-value pair in Redis with optional TTL.",
        parameters: z.object({
          key: z.string().describe("The key to set"),
          value: z.string().describe("The value to store"),
          ttl: z.number().optional().describe("Time-to-live in seconds (omit for no expiry)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const redis = await this.getClient();
            const key = this.fullKey(args.key as string);
            if (args.ttl) {
              await redis.setex(key, args.ttl as number, args.value as string);
            } else {
              await redis.set(key, args.value as string);
            }
            return "OK";
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "redis_delete",
        description: "Delete one or more keys from Redis.",
        parameters: z.object({
          keys: z.array(z.string()).describe("Keys to delete"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const redis = await this.getClient();
            const fullKeys = (args.keys as string[]).map((k) => this.fullKey(k));
            const deleted = await redis.del(...fullKeys);
            return JSON.stringify({ deleted });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "redis_list_keys",
        description: "List keys matching a pattern.",
        parameters: z.object({
          pattern: z.string().optional().describe("Glob pattern (default '*')"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const redis = await this.getClient();
            const pattern = this.fullKey((args.pattern as string) ?? "*");
            const keys: string[] = [];
            let cursor = "0";
            do {
              const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", this.maxKeys);
              cursor = nextCursor;
              keys.push(...batch);
              if (keys.length >= this.maxKeys) break;
            } while (cursor !== "0");

            if (keys.length === 0) return "(no keys found)";
            const trimmedKeys = this.prefix
              ? keys.slice(0, this.maxKeys).map((k: string) => k.slice(this.prefix.length))
              : keys.slice(0, this.maxKeys);
            return trimmedKeys.join("\n");
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "redis_increment",
        description: "Increment a numeric key by a given amount.",
        parameters: z.object({
          key: z.string().describe("The key to increment"),
          amount: z.number().optional().describe("Increment amount (default 1)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const redis = await this.getClient();
            const key = this.fullKey(args.key as string);
            const amount = (args.amount as number) ?? 1;
            const result = Number.isInteger(amount)
              ? await redis.incrby(key, amount)
              : await redis.incrbyfloat(key, amount);
            return String(result);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
