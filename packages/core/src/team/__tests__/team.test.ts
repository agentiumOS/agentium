import { beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture } from "../../agent/__tests__/execution-fixture.js";
import { Agent } from "../../agent/agent.js";
import type { RunOutput } from "../../agent/types.js";
import { EventBus } from "../../events/event-bus.js";
import { createHandoffTool } from "../../handoff/handoff-tool.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse } from "../../models/types.js";
import { Team } from "../team.js";
import { TeamMode } from "../types.js";

function makeUsage(p = 10, c = 5) {
  return { promptTokens: p, completionTokens: c, totalTokens: p + c };
}

function mockAgent(name: string, response: string): Agent {
  return {
    name,
    instructions: `Agent ${name}`,
    eventBus: new EventBus(),
    run: vi.fn().mockResolvedValue({
      text: response,
      toolCalls: [],
      usage: makeUsage(),
    } satisfies RunOutput),
    stream: vi.fn(),
  } as unknown as Agent;
}

function mockModel(response: string): ModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-model",
    generate: vi.fn().mockResolvedValue({
      message: { role: "assistant", content: response },
      usage: makeUsage(),
    }),
    stream: vi.fn(),
  } as unknown as ModelProvider;
}

describe("Team", () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    vi.restoreAllMocks();
  });

  describe("creation", () => {
    it("sets name and eventBus from config", () => {
      const team = new Team({
        name: "test-team",
        mode: TeamMode.Broadcast,
        model: mockModel("ok"),
        members: [],
        eventBus,
      });

      expect(team.name).toBe("test-team");
      expect(team.eventBus).toBe(eventBus);
    });

    it("creates its own EventBus when none provided", () => {
      const team = new Team({
        name: "auto-bus",
        mode: TeamMode.Broadcast,
        model: mockModel("ok"),
        members: [],
      });

      expect(team.eventBus).toBeInstanceOf(EventBus);
    });
  });

  describe("events", () => {
    it("emits run.start and run.complete on success", async () => {
      const startHandler = vi.fn();
      const completeHandler = vi.fn();
      const agent = mockAgent("a1", "hello");
      const model = mockModel("synthesized");

      const team = new Team({
        name: "evt-team",
        mode: TeamMode.Broadcast,
        model,
        members: [agent],
        eventBus,
      });

      eventBus.on("run.start", startHandler);
      eventBus.on("run.complete", completeHandler);

      await team.run("test");

      expect(startHandler).toHaveBeenCalledTimes(1);
      expect(startHandler).toHaveBeenCalledWith(expect.objectContaining({ agentName: "evt-team", input: "test" }));
      expect(completeHandler).toHaveBeenCalledTimes(1);
    });

    it("emits run.error when a member throws and mode propagates it", async () => {
      const errorHandler = vi.fn();
      const failAgent = mockAgent("fail", "");
      (failAgent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

      const _model = mockModel("synthesized");

      const team = new Team({
        name: "err-team",
        mode: TeamMode.Route,
        model: mockModel("fail"),
        members: [failAgent],
        eventBus,
      });

      eventBus.on("run.error", errorHandler);

      await expect(team.run("test")).rejects.toThrow("boom");
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("TeamMode.Broadcast (parallel)", () => {
    it("runs all members concurrently and synthesizes results", async () => {
      const a1 = mockAgent("writer", "draft text");
      const a2 = mockAgent("reviewer", "review notes");
      const model = mockModel("final synthesis");

      const team = new Team({
        name: "broadcast-team",
        mode: TeamMode.Broadcast,
        model,
        members: [a1, a2],
        eventBus,
      });

      const result = await team.run("write something");

      expect(a1.run).toHaveBeenCalledWith("write something", expect.objectContaining({}));
      expect(a2.run).toHaveBeenCalledWith("write something", expect.objectContaining({}));
      expect(result.text).toBe("final synthesis");
    });

    it("handles empty members array gracefully", async () => {
      const model = mockModel("empty synthesis");

      const team = new Team({
        name: "empty-team",
        mode: TeamMode.Broadcast,
        model,
        members: [],
        eventBus,
      });

      const result = await team.run("test");
      expect(result.text).toBe("empty synthesis");
    });

    it("emits team.delegate for each member", async () => {
      const delegateHandler = vi.fn();
      eventBus.on("team.delegate" as any, delegateHandler);

      const a1 = mockAgent("alpha", "a");
      const a2 = mockAgent("beta", "b");

      const team = new Team({
        name: "delegate-team",
        mode: TeamMode.Broadcast,
        model: mockModel("done"),
        members: [a1, a2],
        eventBus,
      });

      await team.run("go");
      expect(delegateHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("TeamMode.Route", () => {
    it("routes to the member selected by the model", async () => {
      const a1 = mockAgent("coder", "code result");
      const a2 = mockAgent("designer", "design result");
      const model = mockModel("coder");

      const team = new Team({
        name: "route-team",
        mode: TeamMode.Route,
        model,
        members: [a1, a2],
        eventBus,
      });

      const result = await team.run("write code");

      expect(a1.run).toHaveBeenCalled();
      expect(a2.run).not.toHaveBeenCalled();
      expect(result.text).toBe("code result");
    });

    it("case-insensitive member matching", async () => {
      const a1 = mockAgent("Coder", "code result");
      const model = mockModel("coder");

      const team = new Team({
        name: "ci-route",
        mode: TeamMode.Route,
        model,
        members: [a1],
        eventBus,
      });

      const result = await team.run("write code");
      expect(result.text).toBe("code result");
    });

    it("returns fallback when model selects unknown member", async () => {
      const a1 = mockAgent("coder", "code");
      const model = mockModel("nonexistent");

      const team = new Team({
        name: "route-fallback",
        mode: TeamMode.Route,
        model,
        members: [a1],
        eventBus,
      });

      const result = await team.run("test");
      expect(result.text).toContain("Could not route");
      expect(result.text).toContain("nonexistent");
    });
  });

  describe("TeamMode.Coordinate (default)", () => {
    it("delegates subtasks parsed from model JSON response", async () => {
      const a1 = mockAgent("researcher", "research findings");
      const a2 = mockAgent("writer", "written content");

      const delegationJson = JSON.stringify([
        { memberId: "researcher", task: "research the topic" },
        { memberId: "writer", task: "write the article" },
      ]);

      const model = {
        providerId: "mock",
        modelId: "mock-model",
        generate: vi
          .fn()
          .mockResolvedValueOnce({
            message: { role: "assistant", content: delegationJson },
            usage: makeUsage(),
          })
          .mockResolvedValueOnce({
            message: { role: "assistant", content: "synthesized answer" },
            usage: makeUsage(),
          }),
        stream: vi.fn(),
      } as unknown as ModelProvider;

      const team = new Team({
        name: "coord-team",
        mode: TeamMode.Coordinate,
        model,
        members: [a1, a2],
        eventBus,
      });

      const result = await team.run("write an article");

      expect(a1.run).toHaveBeenCalledWith("research the topic", expect.any(Object));
      expect(a2.run).toHaveBeenCalledWith("write the article", expect.any(Object));
      expect(result.text).toBe("synthesized answer");
    });

    it("falls back to delegating to all members when JSON is invalid", async () => {
      const a1 = mockAgent("helper", "helped");

      const model = {
        providerId: "mock",
        modelId: "mock-model",
        generate: vi
          .fn()
          .mockResolvedValueOnce({
            message: { role: "assistant", content: "not valid json" },
            usage: makeUsage(),
          })
          .mockResolvedValueOnce({
            message: { role: "assistant", content: "fallback synthesis" },
            usage: makeUsage(),
          }),
        stream: vi.fn(),
      } as unknown as ModelProvider;

      const team = new Team({
        name: "coord-fallback",
        mode: TeamMode.Coordinate,
        model,
        members: [a1],
        eventBus,
      });

      const result = await team.run("do something");
      expect(a1.run).toHaveBeenCalled();
      expect(result.text).toBe("fallback synthesis");
    });
  });

  describe("TeamMode.Collaborate", () => {
    it("reaches consensus when model returns CONSENSUS", async () => {
      const a1 = mockAgent("expert1", "answer A");
      const a2 = mockAgent("expert2", "answer B");

      const model = {
        providerId: "mock",
        modelId: "mock-model",
        generate: vi.fn().mockResolvedValue({
          message: { role: "assistant", content: "CONSENSUS: the agreed answer" },
          usage: makeUsage(),
        }),
        stream: vi.fn(),
      } as unknown as ModelProvider;

      const team = new Team({
        name: "collab-team",
        mode: TeamMode.Collaborate,
        model,
        members: [a1, a2],
        maxRounds: 3,
        eventBus,
      });

      const result = await team.run("question");
      expect(result.text).toBe("the agreed answer");
    });

    it("follows up when model returns FOLLOW_UP", async () => {
      const a1 = mockAgent("debater", "my position");

      const model = {
        providerId: "mock",
        modelId: "mock-model",
        generate: vi
          .fn()
          .mockResolvedValueOnce({
            message: { role: "assistant", content: "FOLLOW_UP: clarify your stance" },
            usage: makeUsage(),
          })
          .mockResolvedValueOnce({
            message: { role: "assistant", content: "CONSENSUS: final answer" },
            usage: makeUsage(),
          }),
        stream: vi.fn(),
      } as unknown as ModelProvider;

      const team = new Team({
        name: "followup-team",
        mode: TeamMode.Collaborate,
        model,
        members: [a1],
        maxRounds: 3,
        eventBus,
      });

      const result = await team.run("debate");
      expect(result.text).toBe("final answer");
      expect(a1.run).toHaveBeenCalledTimes(2);
    });

    it("synthesizes fallback when maxRounds exhausted without consensus", async () => {
      const a1 = mockAgent("stubborn", "no agreement");

      const model = {
        providerId: "mock",
        modelId: "mock-model",
        generate: vi.fn().mockResolvedValue({
          message: { role: "assistant", content: "FOLLOW_UP: keep debating" },
          usage: makeUsage(),
        }),
        stream: vi.fn(),
      } as unknown as ModelProvider;

      const team = new Team({
        name: "no-consensus",
        mode: TeamMode.Collaborate,
        model,
        members: [a1],
        maxRounds: 2,
        eventBus,
      });

      const result = await team.run("endless debate");
      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    });
  });

  describe("deprecated TeamMode.Handoff native journeys", () => {
    function nativeModel(transfer = false): ModelProvider {
      let requested = false;
      return {
        providerId: "fixture",
        modelId: "fixture",
        generate: vi.fn(async (): Promise<ModelResponse> => {
          if (transfer && !requested) {
            requested = true;
            return {
              message: {
                role: "assistant",
                content: null,
                toolCalls: [
                  {
                    id: "transfer",
                    name: "transfer_to_agent",
                    arguments: { agent: "specialist", reason: "needs expert help" },
                  },
                ],
              },
              usage: makeUsage(),
              finishReason: "tool_calls",
              raw: {},
            };
          }
          return {
            message: { role: "assistant", content: "specialist answer" },
            usage: makeUsage(),
            finishReason: "stop",
            raw: {},
          };
        }),
        async *stream() {
          yield { type: "finish", finishReason: "stop", usage: makeUsage() };
        },
      };
    }

    it("cannot route a real native transfer tool through the obsolete thrown-signal Team protocol", async () => {
      const targetModel = nativeModel();
      const target = new Agent({ name: "specialist", register: false, model: targetModel });
      const source = new Agent({
        name: "triage",
        register: false,
        model: nativeModel(true),
        tools: [createHandoffTool([{ agent: target, description: "specialist" }])],
      });
      const team = new Team({
        name: "native-obsolete",
        register: false,
        mode: TeamMode.Handoff,
        model: nativeModel(),
        members: [source, target],
        eventBus,
      });
      await expect(team.run("complex question")).rejects.toThrow("Handoff requested without configured targets");
      expect(targetModel.generate).not.toHaveBeenCalled();
    });

    it("supports direct Agent handoff targets outside controlled execution", async () => {
      const targetModel = nativeModel();
      const target = new Agent({ name: "specialist", register: false, model: targetModel });
      const source = new Agent({
        name: "triage",
        register: false,
        model: nativeModel(true),
        handoff: { targets: [{ agent: target, description: "specialist" }] },
      });
      const result = await source.run("complex question");
      expect(result.text).toBe("specialist answer");
      expect(targetModel.generate).toHaveBeenCalledOnce();
      expect(result.usage.totalTokens).toBe(30);
    });

    it("keeps native Agent transfer ownership outside Team even when configured on a member", async () => {
      const target = new Agent({ name: "specialist", register: false, model: nativeModel() });
      const source = new Agent({
        name: "triage",
        register: false,
        model: nativeModel(true),
        handoff: { targets: [{ agent: target, description: "specialist" }] },
      });
      const delegate = vi.fn();
      eventBus.on("team.delegate", delegate);
      const team = new Team({
        name: "member-owned",
        register: false,
        mode: TeamMode.Handoff,
        model: nativeModel(),
        members: [source, target],
        eventBus,
      });
      expect((await team.run("complex question")).text).toBe("specialist answer");
      expect(delegate).toHaveBeenCalledOnce();
      expect(delegate).toHaveBeenCalledWith(expect.objectContaining({ memberId: "triage" }));
    });

    it("rejects direct Agent handoff inside host execution services before requesting a model", async () => {
      const target = new Agent({ name: "specialist", register: false, model: nativeModel() });
      const model = nativeModel(true);
      const source = new Agent({
        name: "triage",
        register: false,
        model,
        handoff: { targets: [{ agent: target, description: "specialist" }] },
      });
      await expect(source.run("question", { executionServices: executionFixture() })).rejects.toThrow(
        "host-owned delegation",
      );
      expect(model.generate).not.toHaveBeenCalled();
    });
  });

  describe("stream", () => {
    it("yields text and finish chunks", async () => {
      const agent = mockAgent("streamer", "streamed text");
      const model = mockModel("synthesis");

      const team = new Team({
        name: "stream-team",
        mode: TeamMode.Broadcast,
        model,
        members: [agent],
        eventBus,
      });

      const chunks: unknown[] = [];
      for await (const chunk of team.stream("input")) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toEqual({ type: "text", text: "synthesis" });
      expect(chunks[1]).toEqual(expect.objectContaining({ type: "finish", finishReason: "stop" }));
    });
  });

  describe("error propagation", () => {
    it("non-HandoffSignal errors from members propagate in Route mode", async () => {
      const agent = mockAgent("broken", "");
      (agent.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network failure"));
      const model = mockModel("broken");

      const team = new Team({
        name: "error-team",
        mode: TeamMode.Route,
        model,
        members: [agent],
        eventBus,
      });

      await expect(team.run("test")).rejects.toThrow("network failure");
    });
  });
});
