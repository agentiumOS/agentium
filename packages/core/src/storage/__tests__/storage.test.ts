import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../in-memory.js";

describe("InMemoryStorage", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  describe("get()", () => {
    it("returns null for missing keys", async () => {
      expect(await storage.get("ns", "nonexistent")).toBeNull();
    });

    it("returns null for keys in a different namespace", async () => {
      await storage.set("ns1", "key", { data: 42 });
      expect(await storage.get("ns2", "key")).toBeNull();
    });
  });

  describe("set() and get() round-trip", () => {
    it("stores and retrieves a string value", async () => {
      await storage.set("ns", "greeting", "hello");
      expect(await storage.get("ns", "greeting")).toBe("hello");
    });

    it("stores and retrieves an object value", async () => {
      const obj = { name: "test", count: 42, nested: { arr: [1, 2, 3] } };
      await storage.set("ns", "obj", obj);
      expect(await storage.get("ns", "obj")).toEqual(obj);
    });

    it("stores and retrieves a numeric value", async () => {
      await storage.set("ns", "num", 3.14);
      expect(await storage.get("ns", "num")).toBe(3.14);
    });

    it("stores and retrieves a boolean value", async () => {
      await storage.set("ns", "flag", true);
      expect(await storage.get("ns", "flag")).toBe(true);
    });

    it("stores and retrieves null as a value", async () => {
      await storage.set("ns", "nothing", null);
      expect(await storage.get("ns", "nothing")).toBeNull();
    });
  });

  describe("overwriting a key with set()", () => {
    it("replaces the previous value", async () => {
      await storage.set("ns", "key", "first");
      await storage.set("ns", "key", "second");
      expect(await storage.get("ns", "key")).toBe("second");
    });

    it("replaces value with a different type", async () => {
      await storage.set("ns", "key", "string-value");
      await storage.set("ns", "key", { now: "object" });
      expect(await storage.get("ns", "key")).toEqual({ now: "object" });
    });
  });

  describe("delete()", () => {
    it("removes an existing entry", async () => {
      await storage.set("ns", "key", "value");
      await storage.delete("ns", "key");
      expect(await storage.get("ns", "key")).toBeNull();
    });

    it("does not throw when deleting a nonexistent key", async () => {
      await expect(storage.delete("ns", "ghost")).resolves.toBeUndefined();
    });

    it("does not affect other keys in the same namespace", async () => {
      await storage.set("ns", "keep", "alive");
      await storage.set("ns", "remove", "gone");
      await storage.delete("ns", "remove");
      expect(await storage.get("ns", "keep")).toBe("alive");
    });
  });

  describe("list()", () => {
    it("returns all entries in a namespace", async () => {
      await storage.set("ns", "a", 1);
      await storage.set("ns", "b", 2);
      await storage.set("ns", "c", 3);

      const results = await storage.list<number>("ns");
      const keys = results.map((r) => r.key).sort();
      expect(keys).toEqual(["a", "b", "c"]);
      expect(results).toHaveLength(3);
    });

    it("returns empty array for empty namespace", async () => {
      expect(await storage.list("empty-ns")).toEqual([]);
    });

    it("does not return entries from other namespaces", async () => {
      await storage.set("ns1", "key", "val1");
      await storage.set("ns2", "key", "val2");

      const results = await storage.list("ns1");
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe("val1");
    });

    it("filters by prefix", async () => {
      await storage.set("ns", "user:1", { name: "Alice" });
      await storage.set("ns", "user:2", { name: "Bob" });
      await storage.set("ns", "session:1", { token: "xyz" });

      const results = await storage.list("ns", "user:");
      expect(results).toHaveLength(2);
      const names = results.map((r) => (r.value as any).name).sort();
      expect(names).toEqual(["Alice", "Bob"]);
    });

    it("returns empty array when prefix matches nothing", async () => {
      await storage.set("ns", "alpha", 1);
      const results = await storage.list("ns", "beta");
      expect(results).toEqual([]);
    });
  });

  describe("close()", () => {
    it("does not throw", async () => {
      await expect(storage.close()).resolves.toBeUndefined();
    });

    it("clears all data", async () => {
      await storage.set("ns", "key", "value");
      await storage.close();
      expect(await storage.get("ns", "key")).toBeNull();
    });
  });

  describe("namespace isolation", () => {
    it("set in ns1, get from ns2 returns null", async () => {
      await storage.set("ns1", "shared-key", "only-in-ns1");
      expect(await storage.get("ns2", "shared-key")).toBeNull();
    });

    it("same key in different namespaces holds different values", async () => {
      await storage.set("ns1", "key", "value1");
      await storage.set("ns2", "key", "value2");
      expect(await storage.get("ns1", "key")).toBe("value1");
      expect(await storage.get("ns2", "key")).toBe("value2");
    });

    it("deleting from one namespace does not affect another", async () => {
      await storage.set("ns1", "key", "v1");
      await storage.set("ns2", "key", "v2");
      await storage.delete("ns1", "key");
      expect(await storage.get("ns1", "key")).toBeNull();
      expect(await storage.get("ns2", "key")).toBe("v2");
    });
  });
});

describe("StorageDriver interface compliance", () => {
  const requiredMethods = ["get", "set", "delete", "list", "close"] as const;

  it("InMemoryStorage implements all StorageDriver methods", () => {
    const storage = new InMemoryStorage();
    for (const method of requiredMethods) {
      expect(typeof (storage as any)[method]).toBe("function");
    }
  });

  it("PostgresStorage exports and has all StorageDriver methods", async () => {
    const mod = await import("../postgres.js").catch(() => null);
    if (!mod) return; // pg not installed — skip

    const hasCtor = typeof mod.PostgresStorage === "function";
    expect(hasCtor).toBe(true);

    for (const method of requiredMethods) {
      expect(typeof mod.PostgresStorage.prototype[method]).toBe("function");
    }
    expect(typeof mod.PostgresStorage.prototype.initialize).toBe("function");
  });

  it("MongoDBStorage exports and has all StorageDriver methods", async () => {
    const mod = await import("../mongodb.js").catch(() => null);
    if (!mod) return; // mongodb not installed — skip

    const hasCtor = typeof mod.MongoDBStorage === "function";
    expect(hasCtor).toBe(true);

    for (const method of requiredMethods) {
      expect(typeof mod.MongoDBStorage.prototype[method]).toBe("function");
    }
    expect(typeof mod.MongoDBStorage.prototype.initialize).toBe("function");
  });
});
