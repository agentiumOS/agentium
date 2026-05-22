import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { getArtifact } from "../../state/artifact-store.js";
import { defineTool } from "../define-tool.js";
import { ToolExecutor } from "../tool-executor.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("ToolExecutor artifact auto-conversion", () => {
  const bigTool = defineTool({
    name: "fetchLogs",
    description: "fetch big logs",
    parameters: z.object({}),
    execute: async () => "x".repeat(100_000),
  });

  const smallTool = defineTool({
    name: "smallEcho",
    description: "small",
    parameters: z.object({ msg: z.string() }),
    execute: async ({ msg }) => msg,
  });

  it("converts oversized tool output to a pointer when artifacts enabled", async () => {
    const executor = new ToolExecutor([bigTool], { artifacts: { maxToolOutputBytes: 1024, previewChars: 50 } });
    const ctx = makeCtx();

    const [result] = await executor.executeAll([{ id: "c1", name: "fetchLogs", arguments: {} }], ctx);

    const parsed = JSON.parse(result.result as string);
    expect(parsed.pointer).toMatch(/^art:/);
    expect(parsed.sizeBytes).toBeGreaterThan(1024);
    expect(parsed.note).toContain("Output too large");

    const art = getArtifact(ctx, parsed.pointer);
    expect(art).not.toBeNull();
    expect((art?.value as string).length).toBe(100_000);
  });

  it("leaves small outputs alone", async () => {
    const executor = new ToolExecutor([smallTool], { artifacts: { maxToolOutputBytes: 1024, previewChars: 50 } });
    const ctx = makeCtx();

    const [result] = await executor.executeAll([{ id: "c1", name: "smallEcho", arguments: { msg: "hi" } }], ctx);

    expect(result.result).toBe("hi");
  });

  it("does not auto-convert when artifacts config is absent", async () => {
    const executor = new ToolExecutor([bigTool]);
    const ctx = makeCtx();

    const [result] = await executor.executeAll([{ id: "c1", name: "fetchLogs", arguments: {} }], ctx);

    expect((result.result as string).length).toBe(100_000);
  });

  it("does not recursively wrap artifact tools themselves", async () => {
    const { createArtifactTools } = await import("../../state/artifact-tools.js");
    const tools = createArtifactTools();
    const executor = new ToolExecutor(tools, { artifacts: { maxToolOutputBytes: 10, previewChars: 5 } });
    const ctx = makeCtx();

    const [result] = await executor.executeAll(
      [{ id: "c1", name: "storeArtifact", arguments: { name: "x", value: "y".repeat(100) } }],
      ctx,
    );
    const parsed = JSON.parse(result.result as string);
    expect(parsed.pointer).toMatch(/^art:/);
    expect(parsed.note).toBeUndefined();
  });
});
