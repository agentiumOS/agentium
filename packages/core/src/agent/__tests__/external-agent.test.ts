import { beforeEach, describe, expect, it } from "vitest";
import { registry } from "../../serve.js";
import { defineExternalAgent } from "../external-agent.js";

describe("defineExternalAgent", () => {
  beforeEach(() => {
    registry.clear();
  });

  it("wraps a plain run function into a servable agent", async () => {
    const agent = defineExternalAgent({
      name: "external-bot",
      run: async (input) => `echo: ${input}`,
    });

    expect(agent.kind).toBe("agent");
    expect(agent.name).toBe("external-bot");

    const output = await agent.run("hello");
    expect(output.text).toBe("echo: hello");
    expect(output.toolCalls).toEqual([]);
    expect(output.usage.totalTokens).toBe(0);
    expect(output.status).toBe("completed");
    expect(output.agentName).toBe("external-bot");
    expect(output.runId).toBeTruthy();
  });

  it("accepts a partial RunOutput from the run function", async () => {
    const agent = defineExternalAgent({
      name: "partial-bot",
      run: async () => ({
        text: "result",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    });

    const output = await agent.run("x");
    expect(output.text).toBe("result");
    expect(output.usage.totalTokens).toBe(15);
  });

  it("auto-registers in the global registry", () => {
    defineExternalAgent({ name: "registered-bot", run: async () => "ok" });
    expect(registry.getAgent("registered-bot")).toBeDefined();
  });

  it("skips registration when register is false", () => {
    defineExternalAgent({ name: "ghost-bot", run: async () => "ok", register: false });
    expect(registry.getAgent("ghost-bot")).toBeUndefined();
  });

  it("emits run.start and run.complete events", async () => {
    const agent = defineExternalAgent({ name: "evented-bot", run: async () => "done" });

    const events: string[] = [];
    agent.eventBus!.on("run.start", () => events.push("start"));
    agent.eventBus!.on("run.complete", () => events.push("complete"));

    await agent.run("x");
    expect(events).toEqual(["start", "complete"]);
  });

  it("emits run.error and rethrows on failure", async () => {
    const agent = defineExternalAgent({
      name: "failing-bot",
      run: async () => {
        throw new Error("boom");
      },
    });

    const errors: unknown[] = [];
    agent.eventBus!.on("run.error", (e) => errors.push(e));

    await expect(agent.run("x")).rejects.toThrow("boom");
    expect(errors).toHaveLength(1);
  });

  it("default stream yields the run result as text + finish chunks", async () => {
    const agent = defineExternalAgent({ name: "stream-bot", run: async () => "streamed text" });

    const chunks: any[] = [];
    for await (const chunk of agent.stream("x")) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: "text", text: "streamed text" });
    expect(chunks[1].type).toBe("finish");
  });

  it("uses native stream when provided", async () => {
    const agent = defineExternalAgent({
      name: "native-stream-bot",
      run: async () => "unused",
      stream: async function* () {
        yield { type: "text" as const, text: "a" };
        yield { type: "text" as const, text: "b" };
        yield { type: "finish" as const, finishReason: "stop" };
      },
    });

    const chunks: any[] = [];
    for await (const chunk of agent.stream("x")) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => c.text ?? c.type)).toEqual(["a", "b", "finish"]);
  });
});
