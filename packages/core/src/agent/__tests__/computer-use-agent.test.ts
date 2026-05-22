import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComputerAction, type ComputerExecutor, ComputerUseAgent } from "../computer-use-agent.js";

function makeExecutor(impl?: Partial<ComputerExecutor>): ComputerExecutor & {
  execute: ReturnType<typeof vi.fn>;
} {
  const ex: any = {
    displayWidth: 1280,
    displayHeight: 720,
    execute: vi.fn(async () => ({ output: "ok", screenshotBase64: "BASE64" })),
    ...impl,
  };
  return ex;
}

describe("ComputerUseAgent", () => {
  const origKey = process.env.ANTHROPIC_API_KEY;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn();
  });

  afterEach(() => {
    if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  function makeAgent(executor: ComputerExecutor) {
    const agent = new ComputerUseAgent({ executor });
    (agent as any).client = { beta: { messages: { create: mockCreate } } };
    return agent;
  }

  it("returns the final text when no tool_use is requested", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "Hello!" }] });
    const agent = makeAgent(makeExecutor());
    const out = await agent.run("say hi");
    expect(out.text).toBe("Hello!");
    expect(out.iterations).toBe(1);
    expect(out.actions).toEqual([]);
  });

  it("executes computer actions and loops until a final text turn", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "u1", name: "computer", input: { action: "screenshot" } }],
      })
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "u2", name: "computer", input: { action: "left_click", coordinate: [100, 200] } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done." }] });

    const executor = makeExecutor();
    const agent = makeAgent(executor);
    const out = await agent.run("do stuff");

    expect(out.text).toBe("Done.");
    expect(out.actions).toHaveLength(2);
    expect((out.actions[0] as ComputerAction).action).toBe("screenshot");
    expect((out.actions[1] as ComputerAction).action).toBe("left_click");
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("builds the right tool spec including enable_zoom", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "" }] });
    const executor = makeExecutor();
    const agent = makeAgent(executor);
    await agent.run("hi");
    const args = mockCreate.mock.calls[0][0];
    expect(args.tools[0]).toMatchObject({
      type: "computer_20251124",
      name: "computer",
      display_width_px: 1280,
      display_height_px: 720,
      enable_zoom: true,
    });
    expect(args.betas).toContain("computer-use-2025-11-24");
  });

  it("can disable zoom", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "" }] });
    const executor = makeExecutor();
    const agent = new ComputerUseAgent({ executor, enableZoom: false });
    (agent as any).client = { beta: { messages: { create: mockCreate } } };
    await agent.run("x");
    const args = mockCreate.mock.calls[0][0];
    expect(args.tools[0].enable_zoom).toBeUndefined();
  });

  it("stops at maxIterations even if model keeps requesting tools", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "u", name: "computer", input: { action: "screenshot" } }],
    });
    const executor = makeExecutor();
    const agent = new ComputerUseAgent({ executor, maxIterations: 2 });
    (agent as any).client = { beta: { messages: { create: mockCreate } } };
    const out = await agent.run("forever");
    expect(out.iterations).toBe(2);
    expect(out.text).toContain("max iterations reached");
  });
});
