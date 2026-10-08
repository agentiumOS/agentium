import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../agent/agent.js";
import type { ModelProvider } from "../../models/provider.js";
import type { StreamChunk } from "../../models/types.js";
import { Team } from "../../team/team.js";
import { TeamMode } from "../../team/types.js";
import { Workflow } from "../../workflow/workflow.js";
import { withAccountingContext } from "../context.js";
import { CostTracker } from "../cost-tracker.js";
import { fixtureCatalog, fixtureUsage } from "./fixtures.js";

function provider(): ModelProvider {
  return {
    providerId: "fixture",
    modelId: "fixture-model",
    generate: vi.fn(async () => ({
      message: { role: "assistant" as const, content: "answer" },
      finishReason: "stop" as const,
      raw: {},
      usage: {
        promptTokens: 15000,
        completionTokens: 500,
        totalTokens: 15500,
        cachedTokens: 12000,
        cacheWriteTokens: 2000,
        accounting: {
          ...fixtureUsage(),
          context: { providerId: "fixture", billingProviderId: "fixture", modelId: "fixture-model", api: "fixture-v1" },
        },
      },
    })),
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "finish", finishReason: "stop" };
    },
  };
}
function agent(name: string) {
  return new Agent({ name, model: provider(), register: false });
}
describe("orchestration cost DX", () => {
  it("Team returns inclusive costs directly and on terminal stream output", async () => {
    const team = new Team({
      name: "team",
      mode: TeamMode.Broadcast,
      model: provider(),
      members: [agent("member")],
      cost: { catalog: fixtureCatalog() },
      register: false,
    });
    const result = await team.run("hello");
    expect(result.costs).toMatchObject({ status: "available", total: "0.144", attemptCount: 2 });
    const chunks: StreamChunk[] = [];
    for await (const chunk of team.stream("again")) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", costs: { status: "available", total: "0.144" } });
    await team.close();
  });
  it("Workflow returns child costs without a query wrapper", async () => {
    const workflow = new Workflow({
      name: "workflow",
      initialState: {},
      steps: [{ name: "answer", agent: agent("member") }],
      cost: { catalog: fixtureCatalog() },
      register: false,
    });
    const result = await workflow.run();
    expect(result.costs).toMatchObject({ status: "available", total: "0.072", attemptCount: 1 });
    await workflow.close();
  });
  it("cost false inherits the parent's enforced budget", async () => {
    const model = provider();
    const team = new Team({ name: "team", mode: TeamMode.Broadcast, model, members: [], cost: false, register: false });
    const tracker = new CostTracker({ budget: { maxCostPerRun: 0 } });
    await expect(
      withAccountingContext({ tracker, runId: "parent", rootRunId: "parent" }, () => team.run("blocked")),
    ).rejects.toThrow("budget");
    expect(model.generate).not.toHaveBeenCalled();
  });
  it("rejects conflicting tracker options and does not close borrowed trackers", async () => {
    const tracker = new CostTracker();
    const close = vi.spyOn(tracker, "close");
    expect(
      () =>
        new Team({
          name: "bad",
          mode: TeamMode.Broadcast,
          model: provider(),
          members: [],
          cost: true,
          costTracker: tracker,
          register: false,
        }),
    ).toThrow("not both");
    const workflow = new Workflow({
      name: "borrowed",
      initialState: {},
      steps: [],
      costTracker: tracker,
      register: false,
    });
    await workflow.close();
    expect(close).not.toHaveBeenCalled();
  });
});

it("nested workflows with no own model calls retain child costs and exclude siblings", async () => {
  const inner = new Workflow({
    name: "inner",
    initialState: {},
    steps: [{ name: "leaf", agent: agent("leaf") }],
    register: false,
  });
  let innerCosts: unknown;
  const middle = new Workflow({
    name: "middle",
    initialState: {},
    steps: [
      {
        name: "nested",
        run: async () => {
          const result = await inner.run();
          innerCosts = result.costs;
          return {};
        },
      },
    ],
    register: false,
  });
  let middleCosts: unknown;
  const outer = new Workflow({
    name: "outer",
    cost: { catalog: fixtureCatalog() },
    initialState: {},
    steps: [
      {
        name: "nested",
        run: async () => {
          middleCosts = (await middle.run()).costs;
          return {};
        },
      },
      { name: "sibling", agent: agent("sibling") },
    ],
    register: false,
  });
  const result = await outer.run();
  expect(innerCosts).toMatchObject({ status: "available", total: "0.072" });
  expect(middleCosts).toMatchObject({ status: "available", total: "0.072" });
  expect(result.costs).toMatchObject({ status: "available", total: "0.144" });
  await outer.close();
});

it("Workflow close waits through a function step before the next model call", async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const workflow = new Workflow({
    name: "drain",
    cost: { catalog: fixtureCatalog() },
    initialState: {},
    steps: [
      {
        name: "gate",
        run: async () => {
          entered();
          await gate;
          return {};
        },
      },
      { name: "model", agent: agent("child") },
    ],
    register: false,
  });
  const running = workflow.run();
  await started;
  let closed = false;
  const closing = workflow.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  unblock();
  expect((await running).costs).toMatchObject({ status: "available", total: "0.072" });
  await closing;
});
