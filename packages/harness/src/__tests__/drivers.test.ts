import {
  Agent,
  type AgentConfig,
  ApprovalManager,
  InMemoryStorage,
  type ModelProvider,
  type RunOpts,
  type StreamChunk,
  Team,
  TeamMode,
  Workflow,
} from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver, defineHarness, HarnessRuntime, teamDriver, workflowDriver } from "../index.js";
import type { ExecutionDriver } from "../runtime/index.js";
import { testDriverContract } from "../testing.js";

const identity = { userId: "actor", tenantId: "tenant" };
const start = { identity, sessionId: "session" };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
function model(tools = false): ModelProvider {
  let step = 0;
  return {
    providerId: "fixture",
    modelId: "fixture",
    generate: vi.fn(async () =>
      tools && step++ === 0
        ? {
            message: {
              role: "assistant" as const,
              content: null,
              toolCalls: [{ id: "call", name: "effect", arguments: {} }],
              providerExtras: { opaque: "retained" },
            },
            usage,
            finishReason: "tool_calls" as const,
            raw: {},
          }
        : { message: { role: "assistant" as const, content: "answer" }, usage, finishReason: "stop" as const, raw: {} },
    ),
    stream: async function* (): AsyncGenerator<StreamChunk> {
      if (tools && step++ === 0) {
        yield { type: "tool_call_start", toolCall: { id: "call", name: "effect" } };
        yield { type: "tool_call_delta", toolCallId: "call", argumentsDelta: "{}" };
        yield { type: "finish", finishReason: "tool_calls", usage, providerExtras: { opaque: "retained" } };
      } else {
        yield { type: "text", text: "answer" };
        yield { type: "finish", finishReason: "stop", usage };
      }
    },
  };
}
const effect = (execute = vi.fn(async () => "done")) => ({
  name: "effect",
  description: "effect",
  parameters: z.object({}),
  execute,
});

function portDriver(agent: Agent, stream: boolean, extra: Partial<RunOpts> = {}): ExecutionDriver {
  return {
    id: "neutral-port",
    version: 1,
    capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
    async start(request, services) {
      const opts = { executionServices: services, ...extra };
      if (!stream) {
        const result = await agent.run(request.input, opts);
        return { text: result.text };
      }
      let text = "";
      for await (const chunk of agent.stream(request.input, opts)) if (chunk.type === "text") text += chunk.text;
      return { text };
    },
  };
}

describe.each([false, true])("neutral execution-services port stream=%s", (stream) => {
  it.each([false, true])(
    "inherits verified identity and cancels pending approvals (additional signal=%s)",
    async (additionalSignal) => {
      const tool = effect();
      const manager = new ApprovalManager({ policy: "all" });
      const agent = new Agent({
        name: "port",
        userId: "configured-default",
        model: model(true),
        tools: [tool],
        register: false,
      });
      const rt = new HarnessRuntime({
        driver: portDriver(agent, stream, additionalSignal ? { signal: new AbortController().signal } : {}),
        approvalManager: manager,
        grants: { toolIds: ["effect"], modelRoles: ["main"] },
      });
      const handle = rt.start("approval", start);
      try {
        await vi.waitFor(() => expect(manager.listPending()).toHaveLength(1));
        expect(manager.listPending()[0]).toMatchObject({
          userId: identity.userId,
          tenantId: identity.tenantId,
          runId: handle.runId,
        });
        handle.cancel();
        await expect(handle.result()).resolves.toMatchObject({ status: "cancelled" });
        expect(manager.listPending()).toHaveLength(0);
        expect(tool.execute).not.toHaveBeenCalled();
      } finally {
        manager.close();
        await handle.result();
        await agent.close();
      }
    },
  );
  it.each([{ userId: "forged" }, { tenantId: "forged" }, { runMode: "execute" as const }])(
    "rejects identity/mode widening before Agent setup (%j)",
    async (extra) => {
      const beforeRun = vi.fn();
      const provider = model();
      const agent = new Agent({ name: "port", model: provider, register: false, hooks: { beforeRun } });
      try {
        const rt = new HarnessRuntime({
          driver: portDriver(agent, stream, extra),
          grants: { toolIds: [], modelRoles: ["main"] },
        });
        expect(await rt.run("invalid", { ...start, runMode: "plan" })).toMatchObject({
          status: "failed",
          reason: { message: expect.stringMatching(/cannot be overridden|cannot be weakened/) },
        });
        expect(beforeRun).not.toHaveBeenCalled();
        expect(provider.generate).not.toHaveBeenCalled();
      } finally {
        await agent.close();
      }
    },
  );
});

it("port-only roots retain canonical history while delegated runs keep separate scope/history", async () => {
  const captured: Array<{ input: string; history: string[]; runId: string; sessionId: string }> = [];
  const agent = new Agent({
    name: "port-history",
    model: model(),
    register: false,
    hooks: {
      beforeRun: async (ctx) => {
        captured.push({
          input: "",
          history: (ctx.externalHistory ?? []).map((message) => String(message.content)),
          runId: ctx.runId,
          sessionId: ctx.sessionId,
        });
      },
    },
  });
  const rt = new HarnessRuntime({ driver: portDriver(agent, false), grants: { toolIds: [], modelRoles: ["main"] } });
  try {
    const first = rt.start("first root", start);
    await first.result();
    const second = rt.start("second root", start);
    await second.result();
    expect(captured[0].runId).toBe(first.runId);
    expect(captured[1].runId).toBe(second.runId);
    expect(captured[1].history).toContain("first root");
    const childRt = new HarnessRuntime({
      sessionStore: rt.sessions,
      grants: { toolIds: [], modelRoles: ["main"] },
      driver: {
        ...portDriver(agent, false),
        async start(request, services) {
          const result = await agent.run("child work", {
            executionServices: services,
            sessionId: "child-session",
            metadata: { parentRunId: request.runId },
          });
          return { text: result.text };
        },
      },
    });
    const child = childRt.start("delegation", start);
    await child.result();
    expect(captured[2].runId).not.toBe(child.runId);
    expect(captured[2].sessionId).toBe("child-session");
    expect(captured[2].history).toEqual([]);
  } finally {
    await agent.close();
  }
});

for (const stream of [false, true])
  describe(`Agent adapter stream=${stream}`, () => {
    for (const configured of [false, true]) {
      it.each(["agent", "host"] as const)(
        `preserves %s denial with a permissive other approval manager (configured=${configured})`,
        async (denyingOwner) => {
          const tool = effect();
          const localDecision = vi.fn(async () => ({ approved: false }));
          const hostDecision = vi.fn(async () => ({ approved: false }));
          const host = new ApprovalManager({
            policy: denyingOwner === "host" ? "all" : "none",
            onApproval: hostDecision,
          });
          const config: AgentConfig = {
            name: "approval-boundary",
            model: model(true),
            tools: [tool],
            register: false,
            approval: { policy: denyingOwner === "agent" ? "all" : "none", onApproval: localDecision },
          };
          const borrowed = configured ? undefined : new Agent(config);
          const rt = new HarnessRuntime({
            driver: agentDriver(borrowed ?? config, { stream }),
            approvalManager: host,
            grants: { toolIds: ["effect"], modelRoles: ["main"] },
          });
          try {
            expect((await rt.run("work", start)).status).toBe("completed");
            expect(tool.execute).not.toHaveBeenCalled();
            expect(localDecision).toHaveBeenCalledTimes(denyingOwner === "agent" ? 1 : 0);
            expect(hostDecision).toHaveBeenCalledTimes(denyingOwner === "host" ? 1 : 0);
          } finally {
            await borrowed?.close();
            host.close();
          }
        },
      );
      it(`deduplicates one shared approval manager (configured=${configured})`, async () => {
        const decide = vi.fn(async () => ({ approved: true }));
        const shared = new ApprovalManager({ policy: "all", onApproval: decide });
        const tool = effect();
        const config: AgentConfig = {
          name: "shared-approval",
          model: model(true),
          tools: [tool],
          approvalManager: shared,
          register: false,
        };
        const borrowed = configured ? undefined : new Agent(config);
        const rt = new HarnessRuntime({
          driver: agentDriver(borrowed ?? config, { stream }),
          approvalManager: shared,
          grants: { toolIds: ["effect"], modelRoles: ["main"] },
        });
        try {
          expect((await rt.run("work", start)).status).toBe("completed");
          expect(decide).toHaveBeenCalledOnce();
          expect(tool.execute).toHaveBeenCalledOnce();
        } finally {
          await borrowed?.close();
          shared.close();
        }
      });
    }
    it("preserves tool/opaque transcript, usage, terminal status and ephemeral session ownership", async () => {
      const storage = new InMemoryStorage();
      const tool = effect();
      const agent = new Agent({
        name: "agent",
        model: model(true),
        tools: [tool],
        memory: { storage, summaries: false },
        register: false,
      });
      const rt = new HarnessRuntime({
        driver: agentDriver(agent, { stream }),
        grants: { toolIds: ["effect"], modelRoles: ["main"] },
      });
      const handle = rt.start("hello", start);
      const events = [];
      for await (const event of handle.events()) events.push(event);
      const result = await handle.result();
      expect(result).toMatchObject({ status: "completed", text: "answer", usage: { totalTokens: 4 } });
      expect(events.filter((event) => event.payload.type === "tool.complete")).toHaveLength(1);
      expect(tool.execute).toHaveBeenCalledOnce();
      const lease = await rt.sessions.acquire(identity, "session");
      const saved = lease.read();
      lease.release();
      expect(saved.history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      expect(saved.history[1].providerExtras?.opaque).toBe("retained");
      expect(saved.conversations?.[handle.runId]).toHaveLength(4);
      expect(await storage.list("sessions")).toEqual([]);
      expect((await rt.start("second", start).result()).status).toBe("completed");
      await agent.close();
    });
    it("host denial survives agent tools and callback overrides", async () => {
      const tool = effect();
      const agent = new Agent({
        name: "agent",
        model: model(true),
        tools: [{ ...tool, requiresApproval: false }],
        register: false,
      });
      const rt = new HarnessRuntime({
        driver: agentDriver(agent, { stream }),
        grants: { toolIds: ["effect"], modelRoles: ["main"] },
        executionPolicy: { decide: () => ({ action: "deny", reason: "host denied" }) },
      });
      expect((await rt.start("hello", start).result()).status).toBe("completed");
      expect(tool.execute).not.toHaveBeenCalled();
      await agent.close();
    });
    it("stopped loop status and configured checkpoint snapshots are truthful", async () => {
      const agent = new Agent({
        name: "agent",
        model: model(true),
        tools: [effect()],
        maxToolRoundtrips: 1,
        loopHooks: { onRoundtripComplete: async () => ({ stop: true }) },
        checkpointing: true,
        register: false,
      });
      const rt = new HarnessRuntime({
        driver: agentDriver(agent, { stream }),
        grants: { toolIds: ["effect"], modelRoles: ["main"] },
      });
      const handle = rt.start("hello", start);
      expect((await handle.result()).status).toBe("stopped");
      const snapshots = await agent.checkpointManager!.list(handle.runId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].messages.at(-1)?.role).toBe("tool");
      await agent.close();
    });
  });

it("deterministic workflow function effects use scoped human approvals and initial state overrides", async () => {
  const approvals: unknown[] = [];
  const executed = vi.fn();
  const manager = new ApprovalManager({
    policy: "none",
    onApproval: async (request) => {
      approvals.push(request);
      return { approved: true };
    },
  });
  const workflow = new Workflow({
    name: "purchase",
    register: false,
    initialState: { count: 1, retained: true },
    steps: [
      {
        name: "submit",
        run: async (state, ctx) => {
          executed(ctx.tenantId, ctx.runMode, ctx.signal);
          return { count: state.count + 1 };
        },
      },
    ],
  });
  const rt = new HarnessRuntime({
    driver: workflowDriver(workflow),
    grants: { toolIds: ["workflow:submit"], modelRoles: [] },
    approvalManager: manager,
    executionPolicy: { decide: () => ({ action: "ask" }), resolveEffect: () => "read" },
  });
  const result = await rt.start('{"count":4}', { ...start, runMode: "plan" }).result();
  expect(result).toMatchObject({ status: "completed", structured: { count: 5, retained: true } });
  expect(approvals).toMatchObject([{ tenantId: "tenant", userId: "actor", toolName: "workflow:submit" }]);
  expect(executed).toHaveBeenCalledWith("tenant", "plan", expect.any(AbortSignal));
  manager.close();
});

it("workflow denial prevents function side effects and reports failed step", async () => {
  const execute = vi.fn(async () => ({}));
  const workflow = new Workflow({
    name: "workflow",
    initialState: {},
    register: false,
    steps: [{ name: "danger", run: execute }],
  });
  const rt = new HarnessRuntime({ driver: workflowDriver(workflow), grants: { toolIds: [], modelRoles: [] } });
  expect((await rt.start("{}", start).result()).reason?.code).toBe("workflow_step_failed");
  expect(execute).not.toHaveBeenCalled();
});

it("Team delegates with aggregate model budgets and host policy", async () => {
  const executed = vi.fn(async () => "effect");
  const member = new Agent({ name: "member", model: model(true), tools: [effect(executed)], register: false });
  const team = new Team({ name: "team", mode: TeamMode.Broadcast, model: model(), members: [member], register: false });
  const rt = new HarnessRuntime({
    driver: teamDriver(team),
    grants: { toolIds: ["effect"], modelRoles: ["main"] },
    executionPolicy: { decide: () => ({ action: "deny" }) },
    budgets: { maxModelCalls: 4 },
  });
  const result = await rt.start("hello", start).result();
  expect(result.status).toBe("completed");
  expect(result.usage.totalTokens).toBeGreaterThanOrEqual(4);
  expect(executed).not.toHaveBeenCalled();
  const lease = await rt.sessions.acquire(identity, "session");
  expect(
    Object.values(lease.read().conversations ?? {}).some((messages) =>
      messages.some((message) => message.role === "tool"),
    ),
  ).toBe(true);
  lease.release();
  await member.close();
});

it("external deterministic fixture uses only public contracts and conformance helper", async () => {
  const driver: ExecutionDriver = {
    id: "external",
    version: 1,
    capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
    async start(request, services) {
      services.append([
        { role: "user", content: request.input },
        { role: "assistant", content: "external answer" },
      ]);
      return { text: "external answer" };
    },
  };
  const definition = defineHarness({ id: "external", runtime: { driver } });
  const report = await testDriverContract(driver, { definition, grants: { toolIds: [], modelRoles: [] } });
  expect(report.result.text).toBe("external answer");
});

it("conformance fixtures dispose session resources once on success and preserve primary failure", async () => {
  for (const fail of [false, true]) {
    const dispose = vi.fn(async () => {
      if (fail) throw new Error("cleanup failure");
    });
    const fixture: ExecutionDriver = {
      id: "cleanup-fixture",
      version: 1,
      capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
      async start(_request, services) {
        await services.resource("fixture", "session", async () => ({ value: {}, ownership: "runtime", dispose }));
        if (fail) throw new Error("primary failure");
        return { text: "done" };
      },
    };
    if (fail) await expect(testDriverContract(fixture)).rejects.toThrow("primary failure");
    else expect((await testDriverContract(fixture)).result.status).toBe("completed");
    expect(dispose).toHaveBeenCalledOnce();
  }
});

it("large Agent outputs use bounded text events and scoped terminal artifacts", async () => {
  const provider = model();
  const text = "x".repeat(100_000);
  provider.generate = async () => ({
    message: { role: "assistant", content: text },
    finishReason: "stop",
    usage,
    raw: {},
  });
  const agent = new Agent({ name: "large", model: provider, register: false });
  const rt = new HarnessRuntime({ driver: agentDriver(agent), grants: { toolIds: [], modelRoles: ["main"] } });
  const handle = rt.start("hello", start);
  const events = [];
  for await (const event of handle.events()) events.push(event);
  const result = await handle.result();
  expect(result.status).toBe("completed");
  expect(result.artifacts).toHaveLength(1);
  expect(rt.getArtifact(identity, "session", result.artifacts![0].id)).toMatchObject({ text });
  expect(events.every((event) => Buffer.byteLength(JSON.stringify(event.payload)) <= 65536)).toBe(true);
  expect(
    events
      .filter((event) => event.payload.type === "text.delta")
      .map((event) => (event.payload.type === "text.delta" ? event.payload.text : ""))
      .join(""),
  ).toBe(text);
  await agent.close();
});
