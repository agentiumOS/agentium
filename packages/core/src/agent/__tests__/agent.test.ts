import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import { registry } from "../../serve.js";
import { defineTool } from "../../tools/define-tool.js";
import { Agent } from "../agent.js";

function mockModel(response: string = "Hello!"): ModelProvider {
  return {
    providerId: "test",
    modelId: "test-model",
    generate: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: "stop",
    }),
    stream: vi.fn(),
  };
}

describe("Agent", () => {
  beforeEach(() => {
    registry.clear();
  });

  it("runs and returns output text", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: mockModel("Hi there"),
      instructions: "Be helpful.",
    });

    const output = await agent.run("Hello");
    expect(output.text).toBe("Hi there");
    expect(output.usage.totalTokens).toBe(15);
  });

  it("includes instructions in system message", async () => {
    const model = mockModel();
    const agent = new Agent({
      name: "test-agent",
      model,
      instructions: "You are a pirate.",
    });

    await agent.run("Ahoy");

    const generateCall = (model.generate as any).mock.calls[0];
    const messages = generateCall[0];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("pirate");
  });

  it("input guardrail blocks the run", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: mockModel(),
      guardrails: {
        input: [
          {
            name: "no-bad-words",
            validate: async (input) => {
              if (typeof input === "string" && input.includes("bad")) {
                return { pass: false, reason: "Contains bad word" };
              }
              return { pass: true };
            },
          },
        ],
      },
    });

    await expect(agent.run("this is bad")).rejects.toThrow(/bad word/i);
  });

  it("emits run.start and run.complete events", async () => {
    const agent = new Agent({
      name: "test-agent",
      model: mockModel(),
    });

    const events: string[] = [];
    agent.eventBus.on("run.start", () => events.push("start"));
    agent.eventBus.on("run.complete", () => events.push("complete"));

    await agent.run("Hi");

    expect(events).toEqual(["start", "complete"]);
  });

  it("allows creating multiple agents with the same name", async () => {
    const agent1 = new Agent({ name: "classifier", model: mockModel("A") });
    const agent2 = new Agent({ name: "classifier", model: mockModel("B") });

    const out1 = await agent1.run("test");
    const out2 = await agent2.run("test");

    expect(out1.text).toBe("A");
    expect(out2.text).toBe("B");
    // Registry holds the latest one (last-write-wins)
    expect(registry.getAgent("classifier")).toBe(agent2);
  });

  it("exposes agent metadata", () => {
    const agent = new Agent({
      name: "meta-agent",
      model: mockModel(),
    });

    expect(agent.name).toBe("meta-agent");
    expect(agent.modelId).toBe("test-model");
    expect(agent.providerId).toBe("test");
  });

  it("passes approval config to tool executor", () => {
    const agent = new Agent({
      name: "approval-agent",
      model: mockModel(),
      tools: [
        defineTool({
          name: "noop",
          description: "noop",
          parameters: z.object({}),
          execute: async () => "ok",
        }),
      ],
      approval: {
        policy: "all",
        onApproval: async () => ({ approved: true }),
      },
    });

    expect(agent.approvalManager).not.toBeNull();
  });
});
