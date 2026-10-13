import { describe, expect, it } from "vitest";
import { TenantScopedStorage } from "../../tenant/tenant-storage.js";
import { InMemoryStorage } from "../in-memory.js";
import { ScopedStorage } from "../scoped.js";

describe("storage identity and ownership", () => {
  it("keeps delimiter-bearing namespaces and keys distinct through reads, listing and deletes", async () => {
    const storage = new InMemoryStorage();
    await storage.set("parent:child", "key", 1);
    await storage.set("parent", "child:key", 2);
    await storage.set("parent", "child:?[]\\雪", 3);
    expect(await storage.get("parent:child", "key")).toBe(1);
    expect(await storage.list("parent:child")).toEqual([{ key: "key", value: 1 }]);
    expect(await storage.list("parent", "child:")).toEqual([
      { key: "child:key", value: 2 },
      { key: "child:?[]\\雪", value: 3 },
    ]);
    await storage.delete("parent", "child:key");
    expect(await storage.get("parent:child", "key")).toBe(1);
  });

  it("distinguishes delimiter-bearing, absent and empty scopes in tuple-v1 mode", async () => {
    const inner = new InMemoryStorage();
    const scopes = [
      { tenantId: "a:user:b" },
      { tenantId: "a", userId: "b" },
      {},
      { tenantId: "" },
      { userId: "" },
      { tenantId: "", userId: "" },
      { tenantId: "雪\ud800", userId: "*?[]\\" },
    ];
    const wrappers = scopes.map((scope) => new ScopedStorage(inner, scope, { keyEncoding: "tuple-v1" }));
    for (const [index, storage] of wrappers.entries()) await storage.set("data:ns", "key", index);
    for (const [index, storage] of wrappers.entries()) {
      expect(await storage.get("data:ns", "key")).toBe(index);
      expect(await storage.list("data:ns", "ke")).toEqual([{ key: "key", value: index }]);
    }
  });

  it("isolates tenant namespace boundaries and never falls back to legacy data", async () => {
    const inner = new InMemoryStorage();
    const one = new TenantScopedStorage(inner, "a:b", { keyEncoding: "tuple-v1" });
    const two = new TenantScopedStorage(inner, "a", { keyEncoding: "tuple-v1" });
    await one.set("c", "key", 1);
    await two.set("b:c", "key", 2);
    expect(await one.get("c", "key")).toBe(1);
    expect(await two.get("b:c", "key")).toBe(2);
    await new TenantScopedStorage(inner, "legacy").set("data", "key", 3);
    expect(await new TenantScopedStorage(inner, "legacy", { keyEncoding: "tuple-v1" }).get("data", "key")).toBeNull();
    await new ScopedStorage(inner, { tenantId: "legacy" }).set("data", "key", 4);
    expect(
      await new ScopedStorage(inner, { tenantId: "legacy" }, { keyEncoding: "tuple-v1" }).get("data", "key"),
    ).toBeNull();
  });

  it("closing borrowed wrappers leaves a shared driver usable, while legacy ownership still closes it", async () => {
    const inner = new InMemoryStorage();
    const scoped = new ScopedStorage(inner, { tenantId: "a" }, { ownsInner: false });
    const tenant = new TenantScopedStorage(inner, "b", { ownsInner: false });
    await inner.set("shared", "key", 1);
    await scoped.close();
    await tenant.close();
    expect(await inner.get("shared", "key")).toBe(1);
    await new ScopedStorage(inner, {}).close();
    expect(await inner.get("shared", "key")).toBeNull();
  });
});
