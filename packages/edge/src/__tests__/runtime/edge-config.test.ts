import { describe, expect, it } from "vitest";
import { customEdgePreset, edgePreset, listEdgePresets } from "../../runtime/edge-config.js";

describe("EdgeConfig", () => {
  describe("edgePreset", () => {
    it("returns pi4-4gb preset", () => {
      const preset = edgePreset("pi4-4gb");
      expect(preset.id).toBe("pi4-4gb");
      expect(preset.recommendedModel).toBe("tinyllama:1.1b");
      expect(preset.maxTokens).toBe(512);
      expect(preset.contextWindow).toBe(4096);
      expect(preset.memoryLimitMb).toBe(1024);
    });

    it("returns pi5-8gb preset", () => {
      const preset = edgePreset("pi5-8gb");
      expect(preset.id).toBe("pi5-8gb");
      expect(preset.recommendedModel).toBe("phi3:mini");
      expect(preset.maxTokens).toBe(2048);
      expect(preset.contextWindow).toBe(16384);
    });

    it("throws for unknown preset", () => {
      expect(() => edgePreset("pi6-16gb")).toThrow("Unknown edge preset");
    });

    it("returns a copy (not the original)", () => {
      const a = edgePreset("pi4-4gb");
      const b = edgePreset("pi4-4gb");
      a.maxTokens = 999;
      expect(b.maxTokens).toBe(512);
    });
  });

  describe("listEdgePresets", () => {
    it("returns all available presets", () => {
      const presets = listEdgePresets();
      expect(presets.length).toBeGreaterThanOrEqual(4);
      expect(presets.map((p) => p.id)).toContain("pi4-4gb");
      expect(presets.map((p) => p.id)).toContain("pi5-8gb");
    });
  });

  describe("customEdgePreset", () => {
    it("creates custom preset based on existing", () => {
      const custom = customEdgePreset("pi5-8gb", { maxTokens: 4096 });
      expect(custom.maxTokens).toBe(4096);
      expect(custom.recommendedModel).toBe("phi3:mini"); // inherited
      expect(custom.id).toBe("pi5-8gb-custom");
    });

    it("allows custom id", () => {
      const custom = customEdgePreset("pi4-4gb", { id: "my-custom", maxTokens: 256 });
      expect(custom.id).toBe("my-custom");
    });
  });
});
