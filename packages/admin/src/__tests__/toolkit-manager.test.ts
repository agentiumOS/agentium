import { InMemoryStorage } from "@agentium/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolkitManager } from "../toolkit-manager.js";

describe("ToolkitManager", () => {
  let storage: InMemoryStorage;
  let manager: ToolkitManager;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.initialize?.();
    manager = new ToolkitManager(storage);
  });

  // ── Catalog ──────────────────────────────────────────────────────

  describe("catalog", () => {
    it("lists all available toolkit types", () => {
      const catalog = manager.listCatalog();
      expect(catalog.length).toBeGreaterThanOrEqual(18);
    });

    it("gets a single catalog entry", () => {
      const entry = manager.getCatalogEntry("github");
      expect(entry).toBeDefined();
      expect(entry!.name).toBe("GitHub");
      expect(entry!.requiresCredentials).toBe(true);
    });

    it("returns undefined for unknown toolkit type", () => {
      expect(manager.getCatalogEntry("nonexistent")).toBeUndefined();
    });
  });

  // ── Config CRUD ──────────────────────────────────────────────────

  describe("saveConfig", () => {
    it("saves and retrieves a toolkit config", async () => {
      const masked = await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "my-calc",
        config: { precision: 5 },
        enabled: true,
      });

      expect(masked.instanceName).toBe("my-calc");
      expect(masked.toolkitId).toBe("calculator");
      expect(masked.config.precision).toBe(5);

      const loaded = await manager.loadConfig("my-calc");
      expect(loaded).toBeDefined();
      expect(loaded!.instanceName).toBe("my-calc");
    });

    it("throws on unknown toolkit type", async () => {
      await expect(
        manager.saveConfig({
          toolkitId: "nonexistent",
          instanceName: "test",
          config: {},
          enabled: true,
        }),
      ).rejects.toThrow("Unknown toolkit type");
    });

    it("masks secret fields in responses", async () => {
      const masked = await manager.saveConfig({
        toolkitId: "github",
        instanceName: "my-github",
        config: { token: "ghp_super_secret_token_1234567890" },
        enabled: false,
      });

      expect(masked.config.token).not.toBe("ghp_super_secret_token_1234567890");
      expect((masked.config.token as string).includes("*")).toBe(true);
      expect((masked.config.token as string).startsWith("ghp_")).toBe(true);
    });

    it("masks short secrets fully", async () => {
      const masked = await manager.saveConfig({
        toolkitId: "github",
        instanceName: "my-gh2",
        config: { token: "short" },
        enabled: false,
      });

      expect(masked.config.token).toBe("********");
    });
  });

  describe("listConfigs", () => {
    it("lists all saved configs (masked)", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: {},
        enabled: true,
      });
      await manager.saveConfig({
        toolkitId: "wikipedia",
        instanceName: "wiki1",
        config: { language: "fr" },
        enabled: true,
      });

      const configs = await manager.listConfigs();
      expect(configs).toHaveLength(2);
    });
  });

  describe("updateConfig", () => {
    it("updates non-secret fields", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: { precision: 5 },
        enabled: true,
      });

      const updated = await manager.updateConfig("calc1", { config: { precision: 10 } });
      expect(updated.config.precision).toBe(10);
    });

    it("does not overwrite secrets with masked values", async () => {
      await manager.saveConfig({
        toolkitId: "github",
        instanceName: "gh1",
        config: { token: "ghp_real_token_here_12345678" },
        enabled: false,
      });

      const updated = await manager.updateConfig("gh1", {
        config: { token: "ghp_**********************", apiBase: "https://ghe.example.com" },
      });

      expect(updated.config.apiBase).toBe("https://ghe.example.com");
      expect((updated.config.token as string).startsWith("ghp_")).toBe(true);
      expect((updated.config.token as string).includes("*")).toBe(true);
    });

    it("throws if config not found", async () => {
      await expect(manager.updateConfig("nonexistent", {})).rejects.toThrow("not found");
    });
  });

  describe("deleteConfig", () => {
    it("deletes a saved config", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: {},
        enabled: true,
      });

      const deleted = await manager.deleteConfig("calc1");
      expect(deleted).toBe(true);

      const loaded = await manager.loadConfig("calc1");
      expect(loaded).toBeNull();
    });

    it("returns false if not found", async () => {
      expect(await manager.deleteConfig("nonexistent")).toBe(false);
    });
  });

  // ── Tool library ─────────────────────────────────────────────────

  describe("tool library", () => {
    it("empty initially", () => {
      expect(Object.keys(manager.getToolLibrary())).toHaveLength(0);
    });

    it("populates tool library when enabled toolkit is saved", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: {},
        enabled: true,
      });

      const lib = manager.getToolLibrary();
      expect(Object.keys(lib).length).toBeGreaterThan(0);
      expect(lib.calculate).toBeDefined();
    });

    it("does not populate tool library when disabled", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc-disabled",
        config: {},
        enabled: false,
      });

      expect(Object.keys(manager.getToolLibrary())).toHaveLength(0);
    });

    it("removes tools when config is deleted", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: {},
        enabled: true,
      });

      expect(manager.getToolLibrary().calculate).toBeDefined();

      await manager.deleteConfig("calc1");
      expect(manager.getToolLibrary().calculate).toBeUndefined();
    });
  });

  // ── Hydration ────────────────────────────────────────────────────

  describe("hydrate", () => {
    it("re-instantiates enabled configs from storage", async () => {
      await manager.saveConfig({
        toolkitId: "calculator",
        instanceName: "calc1",
        config: {},
        enabled: true,
      });
      await manager.saveConfig({
        toolkitId: "wikipedia",
        instanceName: "wiki-disabled",
        config: {},
        enabled: false,
      });

      const freshManager = new ToolkitManager(storage);
      expect(Object.keys(freshManager.getToolLibrary())).toHaveLength(0);

      const result = await freshManager.hydrate();
      expect(result.total).toBe(2);
      expect(result.active).toBe(1);
      expect(result.failed).toHaveLength(0);

      expect(freshManager.getToolLibrary().calculate).toBeDefined();
    });
  });
});
