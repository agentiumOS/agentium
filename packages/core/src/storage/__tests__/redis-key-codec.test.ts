import { beforeEach, describe, expect, it, vi } from "vitest";
import { RedisStorage } from "../redis.js";

const fake = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  patterns: [] as string[],
  expirations: [] as Array<{ key: string; ttl: number }>,
}));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (filename: string | URL) => {
      const require = original.createRequire(filename);
      const mocked = (id: string) => {
        if (id !== "ioredis") return require(id);
        return class {
          async ping() {
            return "PONG";
          }
          async quit() {
            return "OK";
          }
          async get(key: string) {
            return fake.entries.get(key) ?? null;
          }
          async set(key: string, value: string) {
            fake.entries.set(key, value);
          }
          async setex(key: string, ttl: number, value: string) {
            fake.expirations.push({ key, ttl });
            fake.entries.set(key, value);
          }
          async del(key: string) {
            fake.entries.delete(key);
          }
          async mget(...keys: string[]) {
            return keys.map((key) => fake.entries.get(key) ?? null);
          }
          async scan(cursor: string, _match: string, pattern: string) {
            fake.patterns.push(pattern);
            // v1 prefixes are literal hex and only the trailing star is a wildcard.
            const keys = [...fake.entries.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)));
            const offset = Number(cursor);
            return [offset + 1 < keys.length ? String(offset + 1) : "0", keys.slice(offset, offset + 1)];
          }
        };
      };
      return Object.assign(mocked, require);
    },
  };
});

beforeEach(() => {
  fake.entries.clear();
  fake.patterns.length = 0;
  fake.expirations.length = 0;
});

describe("Redis key identity", () => {
  it("keeps delimiter-bearing physical segments distinct", async () => {
    const one = new RedisStorage({ keyPrefix: "p:q", keyEncoding: "tuple-v1" });
    const two = new RedisStorage({ keyPrefix: "p", keyEncoding: "tuple-v1" });
    await one.set("ns", "key", 1);
    await two.set("q:ns", "key", 2);
    await one.set("ns:key", "", 3);
    expect(await one.get("ns", "key")).toBe(1);
    expect(await two.get("q:ns", "key")).toBe(2);
    expect(await one.list("ns")).toEqual([{ key: "key", value: 1 }]);
    await two.delete("q:ns", "key");
    expect(await one.get("ns", "key")).toBe(1);
  });

  it("scans all pages with literal glob, Unicode, empty and surrogate prefixes", async () => {
    const storage = new RedisStorage({ keyPrefix: "*?[]\\雪", keyEncoding: "tuple-v1" });
    const prefix = "*?[]\\雪\ud800";
    await storage.set("n:*?[]\\", `${prefix}:one`, 1);
    await storage.set("n:*?[]\\", `${prefix}:two`, 2);
    await storage.set("n:*?[]\\", "other", 3);
    await storage.set("n:*?[]\\", "", 4);
    expect(await storage.list("n:*?[]\\", prefix)).toEqual([
      { key: `${prefix}:one`, value: 1 },
      { key: `${prefix}:two`, value: 2 },
    ]);
    expect(fake.patterns).toHaveLength(2);
    expect(fake.patterns.every((pattern) => /^agkv1:[0-9a-f]*:[0-9a-f]*:[0-9a-f]*\*$/.test(pattern))).toBe(true);
    expect(await storage.list("n:*?[]\\", "")).toHaveLength(4);
    expect(await storage.get("n:*?[]\\", "")).toBe(4);
  });

  it("preserves TTL and legacy physical keys without v1 fallback", async () => {
    const legacy = new RedisStorage({ ttl: 17 });
    await legacy.set("n", "k", { version: "legacy" });
    expect(fake.entries.get("agentium:n:k")).toBe('{"version":"legacy"}');
    expect(fake.expirations).toEqual([{ key: "agentium:n:k", ttl: 17 }]);
    const v1 = new RedisStorage({ keyEncoding: "tuple-v1", ttl: 19 });
    expect(await v1.get("n", "k")).toBeNull();
    await v1.set("n", "k", { version: "v1" });
    expect(fake.entries.get("agkv1:006100670065006e007400690075006d:006e:006b")).toBe('{"version":"v1"}');
    expect(fake.expirations[1]?.ttl).toBe(19);
    expect(await legacy.get("n", "k")).toEqual({ version: "legacy" });
  });
});
