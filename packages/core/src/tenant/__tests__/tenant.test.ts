import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { extractTenantFromHeaders, extractTenantFromJwt, requireTenant, withTenant } from "../tenant-context.js";
import { TenantScopedStorage } from "../tenant-storage.js";

describe("TenantScopedStorage", () => {
  let baseStorage: InMemoryStorage;

  beforeEach(() => {
    baseStorage = new InMemoryStorage();
  });

  it("isolates data between tenants", async () => {
    const acme = new TenantScopedStorage(baseStorage, "acme");
    const globex = new TenantScopedStorage(baseStorage, "globex");

    await acme.set("sessions", "s1", { user: "alice" });
    await globex.set("sessions", "s1", { user: "bob" });

    const acmeData = await acme.get<any>("sessions", "s1");
    const globexData = await globex.get<any>("sessions", "s1");

    expect(acmeData.user).toBe("alice");
    expect(globexData.user).toBe("bob");
  });

  it("get returns null for other tenant's data", async () => {
    const acme = new TenantScopedStorage(baseStorage, "acme");
    const globex = new TenantScopedStorage(baseStorage, "globex");

    await acme.set("data", "key1", "acme-value");
    expect(await globex.get("data", "key1")).toBeNull();
  });

  it("list only returns current tenant's items", async () => {
    const acme = new TenantScopedStorage(baseStorage, "acme");
    const globex = new TenantScopedStorage(baseStorage, "globex");

    await acme.set("items", "i1", "a");
    await acme.set("items", "i2", "b");
    await globex.set("items", "i1", "c");

    const acmeItems = await acme.list("items");
    expect(acmeItems).toHaveLength(2);

    const globexItems = await globex.list("items");
    expect(globexItems).toHaveLength(1);
  });

  it("delete only affects current tenant", async () => {
    const acme = new TenantScopedStorage(baseStorage, "acme");
    const globex = new TenantScopedStorage(baseStorage, "globex");

    await acme.set("data", "key", "acme");
    await globex.set("data", "key", "globex");

    await acme.delete("data", "key");

    expect(await acme.get("data", "key")).toBeNull();
    expect(await globex.get<string>("data", "key")).toBe("globex");
  });

  it("getTenantId returns the tenant ID", () => {
    const scoped = new TenantScopedStorage(baseStorage, "my-tenant");
    expect(scoped.getTenantId()).toBe("my-tenant");
  });

  it("close delegates to inner storage", async () => {
    const scoped = new TenantScopedStorage(baseStorage, "t1");
    await expect(scoped.close()).resolves.toBeUndefined();
  });
});

describe("tenant context helpers", () => {
  describe("withTenant()", () => {
    it("creates a tenant context", () => {
      const ctx = withTenant("acme", { plan: "enterprise" });
      expect(ctx.tenantId).toBe("acme");
      expect(ctx.metadata?.plan).toBe("enterprise");
    });

    it("works without metadata", () => {
      const ctx = withTenant("simple");
      expect(ctx.tenantId).toBe("simple");
      expect(ctx.metadata).toBeUndefined();
    });
  });

  describe("requireTenant()", () => {
    it("returns tenantId when present", () => {
      const result = requireTenant("acme", { required: true, isolation: "namespace" });
      expect(result).toBe("acme");
    });

    it("throws when required but missing", () => {
      expect(() => requireTenant(undefined, { required: true, isolation: "namespace" })).toThrow(
        "Tenant ID is required",
      );
    });

    it("returns empty string when not required and missing", () => {
      const result = requireTenant(undefined, { required: false, isolation: "namespace" });
      expect(result).toBe("");
    });
  });

  describe("extractTenantFromHeaders()", () => {
    it("extracts from x-tenant-id header", () => {
      expect(extractTenantFromHeaders({ "x-tenant-id": "acme" })).toBe("acme");
    });

    it("extracts from X-Tenant-Id header", () => {
      expect(extractTenantFromHeaders({ "X-Tenant-Id": "globex" })).toBe("globex");
    });

    it("handles array values", () => {
      expect(extractTenantFromHeaders({ "x-tenant-id": ["first", "second"] })).toBe("first");
    });

    it("returns undefined when missing", () => {
      expect(extractTenantFromHeaders({ "content-type": "json" })).toBeUndefined();
    });
  });

  describe("extractTenantFromJwt()", () => {
    it("extracts tenantId claim", () => {
      expect(extractTenantFromJwt({ tenantId: "acme" })).toBe("acme");
    });

    it("extracts tenant_id claim", () => {
      expect(extractTenantFromJwt({ tenant_id: "globex" })).toBe("globex");
    });

    it("extracts org_id claim", () => {
      expect(extractTenantFromJwt({ org_id: "org-1" })).toBe("org-1");
    });

    it("extracts organization_id claim", () => {
      expect(extractTenantFromJwt({ organization_id: "org-2" })).toBe("org-2");
    });

    it("returns undefined when no tenant claim", () => {
      expect(extractTenantFromJwt({ sub: "user-1" })).toBeUndefined();
    });
  });
});
