import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOllama, hasModel, listModelTiers, recommendModel } from "../../runtime/ollama-edge.js";

describe("Ollama Edge Helpers", () => {
  describe("recommendModel", () => {
    it("recommends tinyllama for 1GB RAM", () => {
      const rec = recommendModel(1000);
      expect(rec.model).toBe("tinyllama:1.1b");
      expect(rec.label).toBe("fast");
    });

    it("recommends tinyllama for 2GB RAM", () => {
      const rec = recommendModel(2000);
      expect(rec.model).toBe("tinyllama:1.1b");
    });

    it("recommends llama3.2 for 3GB RAM", () => {
      const rec = recommendModel(3000);
      expect(rec.model).toBe("llama3.2:1b");
    });

    it("recommends phi3 for 6GB RAM", () => {
      const rec = recommendModel(6000);
      expect(rec.model).toBe("phi3:mini");
    });

    it("recommends mistral for 12GB RAM", () => {
      const rec = recommendModel(12000);
      expect(rec.model).toBe("mistral:7b");
    });
  });

  describe("listModelTiers", () => {
    it("returns all model tiers", () => {
      const tiers = listModelTiers();
      expect(tiers.length).toBeGreaterThanOrEqual(4);
      expect(tiers[0].model).toBe("tinyllama:1.1b");
      expect(tiers[0].ramRequired).toBeGreaterThan(0);
    });
  });

  describe("checkOllama", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns running false when fetch fails", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      const status = await checkOllama("http://localhost:11434");
      expect(status.running).toBe(false);
    });

    it("returns running true when Ollama responds", async () => {
      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes("/api/version")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ version: "0.1.0" }),
          });
        }
        if (url.includes("/api/tags")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ models: [{ name: "tinyllama:1.1b" }] }),
          });
        }
        return Promise.reject(new Error("Unknown URL"));
      });

      const status = await checkOllama("http://localhost:11434");
      expect(status.running).toBe(true);
      expect(status.version).toBe("0.1.0");
      expect(status.models).toContain("tinyllama:1.1b");
    });
  });

  describe("hasModel", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns false when Ollama is not running", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await hasModel("tinyllama");
      expect(result).toBe(false);
    });

    it("returns true when model is cached", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: "tinyllama:1.1b" }] }),
      });
      const result = await hasModel("tinyllama");
      expect(result).toBe(true);
    });
  });
});
