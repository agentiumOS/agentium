import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../define-tool.js";

describe("defineTool", () => {
  it("creates a valid ToolDef with required fields", () => {
    const tool = defineTool({
      name: "greet",
      description: "Say hello",
      parameters: z.object({ name: z.string() }),
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    expect(tool.name).toBe("greet");
    expect(tool.description).toBe("Say hello");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("passes through cache config", () => {
    const tool = defineTool({
      name: "cached",
      description: "cached tool",
      parameters: z.object({}),
      execute: async () => "ok",
      cache: { ttl: 5000 },
    });

    expect(tool.cache).toEqual({ ttl: 5000 });
  });

  it("passes through sandbox config", () => {
    const tool = defineTool({
      name: "sandboxed",
      description: "sandboxed tool",
      parameters: z.object({}),
      execute: async () => "ok",
      sandbox: { timeout: 3000, maxMemoryMB: 64 },
    });

    expect(tool.sandbox).toEqual({ timeout: 3000, maxMemoryMB: 64 });
  });

  it("passes through sandbox: true shorthand", () => {
    const tool = defineTool({
      name: "sandboxed",
      description: "sandboxed tool",
      parameters: z.object({}),
      execute: async () => "ok",
      sandbox: true,
    });

    expect(tool.sandbox).toBe(true);
  });

  it("passes through requiresApproval boolean", () => {
    const tool = defineTool({
      name: "dangerous",
      description: "dangerous tool",
      parameters: z.object({}),
      execute: async () => "boom",
      requiresApproval: true,
    });

    expect(tool.requiresApproval).toBe(true);
  });

  it("passes through requiresApproval function", () => {
    const fn = (args: Record<string, unknown>) => args.force === true;
    const tool = defineTool({
      name: "conditional",
      description: "conditional approval",
      parameters: z.object({ force: z.boolean() }),
      execute: async () => "ok",
      requiresApproval: fn,
    });

    expect(tool.requiresApproval).toBe(fn);
  });

  it("execute function receives args correctly", async () => {
    const tool = defineTool({
      name: "add",
      description: "add numbers",
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => `${a + b}`,
    });

    const result = await tool.execute({ a: 2, b: 3 }, {} as any);
    expect(result).toBe("5");
  });
});
