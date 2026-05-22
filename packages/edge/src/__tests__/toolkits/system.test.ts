import { describe, expect, it } from "vitest";
import { SystemToolkit } from "../../toolkits/system.js";

describe("SystemToolkit", () => {
  const toolkit = new SystemToolkit();
  const tools = toolkit.getTools();
  const ctx = {} as any;

  it("has toolkit name 'system'", () => {
    expect(toolkit.name).toBe("system");
  });

  it("returns three tools", () => {
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["system_info", "system_process_list", "system_network_info"]);
  });

  describe("system_info", () => {
    const tool = tools[0];

    it("returns valid JSON with expected fields", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data).toHaveProperty("platform");
      expect(data).toHaveProperty("arch");
      expect(data).toHaveProperty("hostname");
      expect(data).toHaveProperty("uptime_seconds");
      expect(data).toHaveProperty("cpu");
      expect(data).toHaveProperty("memory");
      expect(data).toHaveProperty("disk");
      expect(data.cpu).toHaveProperty("cores");
      expect(data.memory).toHaveProperty("total_bytes");
      expect(data.memory).toHaveProperty("used_percent");
      expect(data.disk).toHaveProperty("total_bytes");
    });

    it("reports positive memory and uptime", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data.memory.total_bytes).toBeGreaterThan(0);
      expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe("system_network_info", () => {
    const tool = tools[2];

    it("returns valid JSON with interfaces array", async () => {
      const result = await tool.execute({}, ctx);
      const data = JSON.parse(result as string);

      expect(data).toHaveProperty("interfaces");
      expect(Array.isArray(data.interfaces)).toBe(true);
    });
  });
});
