import { describe, expect, it, vi } from "vitest";
import type { StorageDriver } from "../driver.js";
import { ScopedStorage } from "../scoped.js";

function makeDriverSpy(): StorageDriver & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
  };
}

describe("ScopedStorage", () => {
  it("prefixes namespace with tenant + user", async () => {
    const inner = makeDriverSpy();
    const scoped = new ScopedStorage(inner, { tenantId: "acme", userId: "u1" });

    await scoped.set("sessions", "k", "v");
    expect(inner.set).toHaveBeenCalledWith("tenant:acme:user:u1:sessions", "k", "v");

    await scoped.get("sessions", "k");
    expect(inner.get).toHaveBeenCalledWith("tenant:acme:user:u1:sessions", "k");

    await scoped.delete("sessions", "k");
    expect(inner.delete).toHaveBeenCalledWith("tenant:acme:user:u1:sessions", "k");
  });

  it("supports tenant-only scope", async () => {
    const inner = makeDriverSpy();
    const scoped = new ScopedStorage(inner, { tenantId: "acme" });

    await scoped.set("logs", "k", "v");
    expect(inner.set).toHaveBeenCalledWith("tenant:acme:logs", "k", "v");
  });

  it("supports empty scope (no prefix)", async () => {
    const inner = makeDriverSpy();
    const scoped = new ScopedStorage(inner, {});

    await scoped.set("logs", "k", "v");
    expect(inner.set).toHaveBeenCalledWith("logs", "k", "v");
  });

  it("isolates two tenants on the same inner driver", async () => {
    const inner = makeDriverSpy();
    const tenantA = new ScopedStorage(inner, { tenantId: "a" });
    const tenantB = new ScopedStorage(inner, { tenantId: "b" });

    await tenantA.set("data", "k", 1);
    await tenantB.set("data", "k", 2);

    expect(inner.set.mock.calls[0]).toEqual(["tenant:a:data", "k", 1]);
    expect(inner.set.mock.calls[1]).toEqual(["tenant:b:data", "k", 2]);
  });

  it("propagates list and close calls through", async () => {
    const inner = makeDriverSpy();
    const scoped = new ScopedStorage(inner, { tenantId: "x" });

    await scoped.list("docs", "prefix-");
    expect(inner.list).toHaveBeenCalledWith("tenant:x:docs", "prefix-");

    await scoped.close();
    expect(inner.close).toHaveBeenCalled();
  });

  it("calls inner.initialize when present", async () => {
    const inner = makeDriverSpy();
    const scoped = new ScopedStorage(inner, {});
    await scoped.initialize();
    expect(inner.initialize).toHaveBeenCalled();
  });
});
