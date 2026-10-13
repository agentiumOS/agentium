import { Agent, type ChatMessage, type ModelProvider, type RunOpts, type ToolDef } from "@agentium/core";
import { expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { defineAbility, defineHarness } from "../definition.js";
import { agentDriver } from "../drivers.js";
import { type ExecutionDriver, HarnessResourcePool, type HarnessRuntimeConfig } from "../runtime/index.js";
import { createHarnessEvalTarget } from "../testing.js";

const identity = { tenantId: "tenant", userId: "user" };
const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
const grants = { toolIds: ["effect"], modelRoles: ["main"] };
function model(captured: ChatMessage[][] = [], tools = true): ModelProvider {
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: async (messages) => {
      captured.push(structuredClone(messages));
      const latestUser = [...messages].reverse().find((message) => message.role === "user");
      const name = String(latestUser?.content);
      const last = messages.at(-1);
      return last?.role === "tool" || !tools
        ? { message: { role: "assistant", content: `answer:${name}` }, usage, finishReason: "stop", raw: {} }
        : {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{ id: `tool:${name}`, name: "effect", arguments: {} }],
            },
            usage,
            finishReason: "tool_calls",
            raw: {},
          };
    },
    stream: async function* () {},
  };
}
const tool = (execute: ToolDef["execute"] = async () => "PRIVATE SOURCE PAYLOAD"): ToolDef => ({
  name: "effect",
  description: "fixture",
  parameters: z.object({}),
  execute,
});
const target = (tools: ToolDef[] = [tool()], extra: Partial<HarnessRuntimeConfig> = {}) =>
  createHarnessEvalTarget({
    identity,
    config: { driver: agentDriver({ name: "eval", model: model(), tools, register: false }), grants, ...extra },
  });
it("evaluates actual named settlements, omits source bodies and absent TTFT", async () => {
  const instance = target();
  const output = await instance.run("one", { sessionId: "one" });
  expect(output).toMatchObject({
    status: "completed",
    text: "answer:one",
    usage: { totalTokens: 6 },
    toolCalls: [{ toolName: "effect", toolCallId: "tool:one" }],
  });
  expect(JSON.stringify(output.toolCalls)).not.toContain("PRIVATE SOURCE");
  expect(output.metrics?.timeToFirstTokenMs).toBeUndefined();
  expect(instance.observation(output)).toMatchObject({
    status: "completed",
    toolCallCoverage: "complete",
    budget: { modelCalls: { used: 2 } },
  });
  expect(instance.observation({ ...output })).toBeUndefined();
});
it("isolates simultaneous observers while retaining explicit-session history", async () => {
  const captured: ChatMessage[][] = [];
  const instance = createHarnessEvalTarget({
    identity,
    config: { driver: agentDriver({ name: "eval", model: model(captured), tools: [tool()], register: false }), grants },
  });
  const [first, second] = await Promise.all([
    instance.run("first", { sessionId: "a" }),
    instance.run("second", { sessionId: "b" }),
  ]);
  expect(first.toolCalls.map((call) => call.toolCallId)).toEqual(["tool:first"]);
  expect(second.toolCalls.map((call) => call.toolCallId)).toEqual(["tool:second"]);
  await instance.run("followup", { sessionId: "a" });
  const followup = captured.find((messages) => messages.at(-1)?.content === "followup");
  expect(JSON.stringify(followup)).toContain("first");
  expect(JSON.stringify(followup)).not.toContain("second");
});
it("preserves policy denial separately from execution error", async () => {
  const denied = target([tool()], { grants: { toolIds: [], modelRoles: ["main"] } });
  const denial = await denied.run("denied");
  expect(denial.toolCalls[0]).toMatchObject({ denial: "policy" });
  const failed = target([
    tool(async () => {
      throw new Error("executor failed");
    }),
  ]);
  const error = await failed.run("failed");
  expect(error.toolCalls[0]?.error).toContain("executor failed");
  expect(error.toolCalls[0]?.denial).toBeUndefined();
});
it("bounds metadata and marks count or byte overflow as partial", async () => {
  const instance = createHarnessEvalTarget({
    identity,
    config: { driver: agentDriver({ name: "eval", model: model(), tools: [tool()], register: false }), grants },
    maxObservationBytes: 1,
  });
  const output = await instance.run("overflow");
  expect(output.toolCalls).toEqual([]);
  expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
});
it("records applied effects when cancellation wins the post-effect guard", async () => {
  const controller = new AbortController();
  let applied = 0;
  const instance = target([
    tool(async () => {
      applied++;
      controller.abort("after applied");
      return "applied";
    }),
  ]);
  const output = await instance.run("cancel", { signal: controller.signal });
  expect(applied).toBe(1);
  expect(output.status).toBe("cancelled");
  expect(output.toolCalls).toHaveLength(1);
  expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
});
it("marks observer failures conservatively without changing execution", async () => {
  const faulty = defineAbility({
    type: "fixture/faulty-observer",
    validate: (value: object) => value,
    describe: () => ({ toolNames: [], requirements: [] }),
    bind: () => ({
      tools: [],
      middleware: [
        {
          id: "faulty",
          observeToolSettlement: () => {
            throw new Error("observation broke");
          },
        },
      ],
    }),
  });
  const instance = target([tool()], { definition: defineHarness({ abilities: [faulty({})] }) });
  const output = await instance.run("observer");
  expect(output.status).toBe("completed");
  expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
});
it.each<RunOpts>([
  { apiKey: "secret" },
  { history: [] },
  { metadata: {} },
  { executionPolicy: { decide: async () => ({ action: "allow" }) } },
  { ephemeral: false },
  { publicMessageEvents: false },
  { runId: "other" },
  { dependencies: {} },
  { questions: {} },
  { userId: "other" },
  { tenantId: "other" },
])("rejects unsupported or identity-widening RunOpts before work (%j)", async (opts) => {
  const provider = model([], false);
  const generate = vi.spyOn(provider, "generate");
  const instance = createHarnessEvalTarget({
    identity,
    config: { driver: agentDriver({ name: "eval", model: provider, register: false }), grants },
  });
  await expect(instance.run("invalid", opts)).rejects.toThrow(/unsupported|identity/i);
  expect(generate).not.toHaveBeenCalled();
});
it("captures verified identity and preserves class ability and policy methods", async () => {
  class Gate {
    id = "gate";
    allowed = false;
    async decide() {
      return { action: this.allowed ? ("allow" as const) : ("deny" as const), reason: "class gate" };
    }
  }
  class Service {
    text = "class service";
    read() {
      return this.text;
    }
  }
  const gate = new Gate();
  const service = new Service();
  const ability = defineAbility({
    type: "fixture/class",
    validate: (value: Service) => value,
    describe: () => ({ toolNames: [], requirements: [] }),
    bind: (value) => ({ tools: [], promptFragments: [{ id: "service", text: value.read() }] }),
  });
  const verified = { ...identity };
  const instance = createHarnessEvalTarget({
    identity: verified,
    config: {
      driver: agentDriver({ name: "eval", model: model(), tools: [tool()], register: false }),
      definition: defineHarness({ abilities: [ability(service)] }),
      executionPolicy: gate,
      grants,
    },
  });
  verified.userId = "mutated";
  const output = await instance.run("class", { userId: identity.userId });
  expect(output.toolCalls[0]?.denial).toBeDefined();
  expect(output.userId).toBe(identity.userId);
});
it.each([false, true])(
  "closes owned resources and leaves borrowed pools to the host (borrowed=%s)",
  async (borrowed) => {
    let disposals = 0;
    const driver: ExecutionDriver = {
      id: "resources",
      version: 1,
      capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
      async start(_request, services) {
        await services.resource("client", "session", async () => ({
          value: {},
          ownership: "runtime",
          dispose: async () => {
            disposals++;
          },
        }));
        return { text: "done" };
      },
    };
    const resources = borrowed ? new HarnessResourcePool() : undefined;
    const instance = createHarnessEvalTarget({ identity, config: { driver, grants, resources } });
    await instance.run("resource", { sessionId: "resource" });
    expect(disposals).toBe(borrowed ? 0 : 1);
    if (resources) {
      await resources.closeSession(identity, "resource");
      expect(disposals).toBe(1);
    }
  },
);
it.each(["failed", "stopped", "awaiting_input"] as const)(
  "maps native status %s without fabricating completion",
  async (status) => {
    const driver: ExecutionDriver = {
      id: "status",
      version: 1,
      capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
      start: async () => ({ text: "status", status }),
    };
    const instance = createHarnessEvalTarget({ identity, config: { driver, grants } });
    const output = await instance.run("status");
    expect(output.status).toBe(status === "failed" ? "error" : "stopped");
    expect(instance.observation(output)?.status).toBe(status);
  },
);

it("retains a bounded tool prefix when the count ceiling is exhausted", async () => {
  const provider: ModelProvider = {
    providerId: "fixture",
    modelId: "two-tools",
    async generate(messages) {
      return messages.at(-1)?.role === "tool"
        ? { message: { role: "assistant", content: "done" }, usage, finishReason: "stop", raw: {} }
        : {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [
                { id: "first", name: "effect", arguments: {} },
                { id: "second", name: "effect", arguments: {} },
              ],
            },
            usage,
            finishReason: "tool_calls",
            raw: {},
          };
    },
    async *stream() {},
  };
  const instance = createHarnessEvalTarget({
    identity,
    maxObservedTools: 1,
    config: { driver: agentDriver({ name: "count", model: provider, tools: [tool()], register: false }), grants },
  });
  const output = await instance.run("count");
  expect(output.toolCalls.map((call) => call.toolCallId)).toEqual(["first"]);
  expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
});
it("does not retain oversized errors as apparently successful tool observations", async () => {
  const instance = createHarnessEvalTarget({
    identity,
    maxObservationBytes: 200,
    config: {
      driver: agentDriver({
        name: "huge",
        model: model(),
        tools: [
          tool(async () => {
            throw new Error("large".repeat(200));
          }),
        ],
        register: false,
      }),
      grants,
    },
  });
  const output = await instance.run("huge");
  expect(output.toolCalls).toEqual([]);
  expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
});
it("preserves cleanup diagnostics while retaining the primary completed output", async () => {
  const driver: ExecutionDriver = {
    id: "cleanup",
    version: 1,
    capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
    async start(_request, services) {
      await services.resource("broken-client", "session", async () => ({
        value: {},
        ownership: "runtime",
        dispose: async () => {
          throw new Error("cleanup failed");
        },
      }));
      return { text: "done" };
    },
  };
  const instance = createHarnessEvalTarget({ identity, config: { driver, grants } });
  const output = await instance.run("cleanup");
  expect(output.status).toBe("completed");
  expect(instance.observation(output)?.cleanupDiagnostics).toContain("broken-client");
});
it("borrows an existing Agent and closes only the adapter's owned session resources", async () => {
  const agent = new Agent({ name: "borrowed", model: model([], false), register: false });
  const close = vi.spyOn(agent, "close");
  try {
    const instance = createHarnessEvalTarget({ identity, config: { driver: agentDriver(agent), grants } });
    expect((await instance.run("borrowed")).status).toBe("completed");
    expect(close).not.toHaveBeenCalled();
  } finally {
    await agent.close();
  }
});
it("observes a locally delegated settled tool exactly once", async () => {
  const agent = new Agent({ name: "delegate", model: model(), tools: [tool()], register: false });
  const driver: ExecutionDriver = {
    id: "delegate-port",
    version: 1,
    capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
    async start(request, services) {
      const output = await agent.run(request.input, { executionServices: services });
      return { text: output.text };
    },
  };
  try {
    const instance = createHarnessEvalTarget({ identity, config: { driver, grants } });
    const output = await instance.run("delegate");
    expect(output.toolCalls.map((call) => call.toolCallId)).toEqual(["tool:delegate"]);
  } finally {
    await agent.close();
  }
});
it("captures declarative budgets and grants without disabling prototype ability gates", async () => {
  const execute = vi.fn(async () => "should remain denied");
  class PrototypeAbility {
    instanceId = "prototype-ability";
    enabled = false;
    validate() {
      if (this.enabled) throw new Error("not enabled");
    }
    describe() {
      return { toolNames: [], requirements: [] };
    }
    async bind() {
      if (this.enabled) throw new Error("not enabled");
      return { tools: [] };
    }
  }
  const config: HarnessRuntimeConfig = {
    driver: agentDriver({ name: "captured", model: model(), tools: [tool(execute)], register: false }),
    definition: { kind: "local", abilities: [new PrototypeAbility()] },
    grants: { toolIds: [], modelRoles: ["main"] },
    budgets: { maxModelCalls: 2 },
  };
  const instance = createHarnessEvalTarget({ identity, config });
  config.grants = grants;
  config.budgets = { maxModelCalls: 100 };
  const output = await instance.run("captured");
  expect(output.toolCalls[0]?.denial).toBe("policy");
  expect(execute).not.toHaveBeenCalled();
  expect(instance.observation(output)?.budget?.modelCalls.limit).toBe(2);
});

it.each([false, true])(
  "observes both parallel applied effects exactly once after cancellation (stream=%s)",
  async (stream) => {
    const controller = new AbortController();
    let effects = 0;
    let release: (() => void) | undefined;
    const bothApplied = new Promise<void>((resolve) => {
      release = resolve;
    });
    const apply = async () => {
      effects++;
      if (effects === 2) release?.();
      await bothApplied;
      controller.abort("both effects applied");
      return "applied";
    };
    let calls = 0;
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "parallel-cancel",
      async generate() {
        calls++;
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "first", name: "first_effect", arguments: {} },
              { id: "second", name: "second_effect", arguments: {} },
            ],
          },
          usage,
          finishReason: "tool_calls",
          raw: {},
        };
      },
      async *stream() {
        calls++;
        yield { type: "tool_call_start", toolCall: { id: "first", name: "first_effect" } };
        yield { type: "tool_call_delta", toolCallId: "first", argumentsDelta: "{}" };
        yield { type: "tool_call_start", toolCall: { id: "second", name: "second_effect" } };
        yield { type: "tool_call_delta", toolCallId: "second", argumentsDelta: "{}" };
        yield { type: "finish", finishReason: "tool_calls", usage };
      },
    };
    const instance = createHarnessEvalTarget({
      identity,
      config: {
        driver: agentDriver(
          {
            name: "parallel-cancel",
            model: provider,
            tools: [
              { ...tool(apply), name: "first_effect" },
              { ...tool(apply), name: "second_effect" },
            ],
            register: false,
          },
          { stream },
        ),
        grants: { toolIds: ["first_effect", "second_effect"], modelRoles: ["main"] },
      },
    });
    const output = await instance.run("parallel", { signal: controller.signal });
    expect(effects).toBe(2);
    expect(calls).toBe(1);
    expect(output.status).toBe("cancelled");
    expect(output.toolCalls.map((call) => call.toolName).sort()).toEqual(["first_effect", "second_effect"]);
    expect(new Set(output.toolCalls.map((call) => call.toolCallId)).size).toBe(2);
    expect(instance.observation(output)?.toolCallCoverage).toBe("partial");
  },
);
