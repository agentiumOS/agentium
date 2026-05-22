import { describe, expect, it } from "vitest";
import { FlashMemoryStore } from "../flash-store.js";

describe("FlashMemoryStore (in-memory fallback)", () => {
  it("falls back to pure in-memory when no path is given", async () => {
    const s = new FlashMemoryStore();
    await s.set("ns", "k", "v");
    expect(await s.get("ns", "k")).toBe("v");
  });

  it("isolates keys across namespaces", async () => {
    const s = new FlashMemoryStore();
    await s.set("a", "k", 1);
    await s.set("b", "k", 2);
    expect(await s.get("a", "k")).toBe(1);
    expect(await s.get("b", "k")).toBe(2);
  });

  it("returns null for missing keys", async () => {
    const s = new FlashMemoryStore();
    expect(await s.get("ns", "missing")).toBeNull();
  });

  it("delete removes keys", async () => {
    const s = new FlashMemoryStore();
    await s.set("ns", "k", "v");
    await s.delete("ns", "k");
    expect(await s.get("ns", "k")).toBeNull();
  });

  it("list returns matching keys with prefix filter", async () => {
    const s = new FlashMemoryStore();
    await s.set("ns", "a:1", "v1");
    await s.set("ns", "a:2", "v2");
    await s.set("ns", "b:1", "v3");
    const all = await s.list<string>("ns");
    expect(all.length).toBe(3);
    const aOnly = await s.list<string>("ns", "a:");
    expect(aOnly.length).toBe(2);
    expect(aOnly.map((x) => x.value).sort()).toEqual(["v1", "v2"]);
  });

  it("evicts least-frequently-used entries when hot cache fills", async () => {
    const s = new FlashMemoryStore({ hotCacheSize: 3 });
    await s.set("ns", "a", 1);
    await s.set("ns", "b", 2);
    await s.set("ns", "c", 3);
    // touch b and c so a is the least-used
    await s.get("ns", "b");
    await s.get("ns", "c");
    await s.set("ns", "d", 4); // forces eviction of a
    // Without cold tier, a is gone forever.
    expect(await s.get("ns", "a")).toBeNull();
    expect(await s.get("ns", "b")).toBe(2);
    expect(await s.get("ns", "c")).toBe(3);
    expect(await s.get("ns", "d")).toBe(4);
  });

  it("close clears the hot tier", async () => {
    const s = new FlashMemoryStore();
    await s.set("ns", "k", "v");
    await s.close();
    expect(await s.get("ns", "k")).toBeNull();
  });

  it("hits update access stats so the entry isn't evicted", async () => {
    const s = new FlashMemoryStore({ hotCacheSize: 2 });
    await s.set("ns", "a", 1);
    await s.set("ns", "b", 2);
    // give a many hits
    for (let i = 0; i < 10; i++) await s.get("ns", "a");
    await s.set("ns", "c", 3); // b should be evicted, not a
    expect(await s.get("ns", "a")).toBe(1);
  });
});
