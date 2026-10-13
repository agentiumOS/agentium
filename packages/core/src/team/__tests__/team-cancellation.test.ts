import { expect, it, vi } from "vitest";
import { Agent } from "../../agent/agent.js";
import { CostTracker } from "../../cost/cost-tracker.js";
import type { ModelProvider } from "../../models/provider.js";
import { Team } from "../team.js";
import { TeamMode } from "../types.js";

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
it.each(["plan", "synthesis"] as const)(
  "passes coordinator signal and rejects late cancellation during %s",
  async (abortAt) => {
    const controller = new AbortController();
    const tracker = new CostTracker();
    let requests = 0;
    const signals: Array<AbortSignal | undefined> = [];
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: vi.fn<ModelProvider["generate"]>(async (_messages, options) => {
        signals.push(options?.signal);
        requests++;
        if (requests === (abortAt === "plan" ? 1 : 2)) controller.abort();
        return {
          message: {
            role: "assistant",
            content: requests === 1 ? '[{"memberId":"member","task":"read"}]' : "synthesized",
          },
          usage,
          finishReason: "stop",
          raw: {},
        };
      }),
      async *stream() {},
    };
    const member = new Agent({
      name: "member",
      register: false,
      model: {
        ...provider,
        generate: vi.fn<ModelProvider["generate"]>(async () => ({
          message: { role: "assistant", content: "member answer" },
          usage,
          finishReason: "stop",
          raw: {},
        })),
      },
    });
    const delegated = vi.spyOn(member, "run");
    const team = new Team({
      name: "cancel-team",
      mode: TeamMode.Coordinate,
      register: false,
      model: provider,
      members: [member],
      costTracker: tracker,
    });
    const complete = vi.fn();
    const delegate = vi.fn();
    team.eventBus.on("run.complete", complete);
    team.eventBus.on("team.delegate", delegate);
    await expect(team.run("question", { signal: controller.signal, runId: "team-run" })).rejects.toThrow();
    expect(signals).toEqual(Array.from({ length: abortAt === "plan" ? 1 : 2 }, () => controller.signal));
    expect(complete).not.toHaveBeenCalled();
    expect(delegated).toHaveBeenCalledTimes(abortAt === "plan" ? 0 : 1);
    expect(delegate).toHaveBeenCalledTimes(abortAt === "plan" ? 0 : 1);
    expect(await tracker.queryRunUsage({ runId: "team-run" })).toMatchObject({
      totalTokens: abortAt === "plan" ? 15 : 30,
    });
  },
);
