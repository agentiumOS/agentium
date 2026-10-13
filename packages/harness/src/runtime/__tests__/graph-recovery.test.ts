import {
  Agent,
  type DurableActionConnector,
  DurableActionLedger,
  DurableGraphJournal,
  DurableGraphJournalError,
  DurableRecoveryRequiredError,
  DurableTaskSupervisor,
  type ExecutionPolicy,
  InMemoryDurableTaskStore,
  type ModelProvider,
  type ModelResponse,
  RootExecutionController,
  RootExecutionError,
} from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { type HarnessExecutionServices, HarnessRuntime, type HarnessStartOptions } from "../driver.js";
import type { GraphToolBinding } from "../graph-contracts.js";
import {
  createGraphRecoveryPorts,
  graphToolOutput,
  resolveGraphEffectBinding,
  scopeGraphServices,
} from "../graph-recovery.js";

const key = { tenantId: "tenant", taskId: "graph" };
const definition = { id: "graph", version: "1", catalogDigest: "catalog", input: {}, limits: {} };
async function fixture() {
  let now = 1000;
  const store = new InMemoryDurableTaskStore({ now: () => now });
  const supervisor = new DurableTaskSupervisor(store, { leaseMs: 100 });
  await store.create({
    id: key.taskId,
    identity: { tenantId: key.tenantId, actorId: "actor", sessionId: "session", runId: "run", rootRunId: "root" },
    manifestHash: "manifest",
    inputRef: "input",
    policyRevision: 1,
    grantRefs: ["read"],
    budget: { maxAttempts: 10 },
  });
  async function claim(worker: string) {
    const task = await supervisor.claim(key, worker);
    if (!task?.lease) throw new Error("Fixture claim failed");
    const journal = new DurableGraphJournal(store, key, task.lease, definition);
    await journal.initialize();
    return journal;
  }
  return {
    store,
    journal: await claim("first"),
    restart: () => {
      now += 101;
      return claim("next");
    },
  };
}
function binding(execute: GraphToolBinding["tool"]["execute"]): GraphToolBinding {
  const parameters = z.object({ value: z.number() });
  return {
    id: "read",
    version: "1",
    kind: "tool",
    input: parameters,
    output: z.string(),
    recovery: "pure",
    tool: { name: "read", description: "Read fixture", parameters, execute },
  };
}
async function withServices(
  tools: readonly GraphToolBinding[],
  root: RootExecutionController,
  operation: (services: HarnessExecutionServices) => Promise<void>,
  policy?: ExecutionPolicy,
  recovery?: HarnessStartOptions["recovery"],
) {
  let failure: unknown;
  const runtime = new HarnessRuntime({
    tools: tools.map((entry) => entry.tool),
    grants: { toolIds: tools.map((entry) => entry.tool.name), modelRoles: ["main"] },
    executionPolicy: policy,
    budgets: { maxToolCalls: 10, maxModelCalls: 5, maxTokens: 100 },
    estimateInputTokens: () => 1,
    driver: {
      id: "fixture",
      version: 1,
      capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
      async start(_request, services) {
        try {
          await operation(recovery ? services : { ...services, invokeTool: undefined });
        } catch (error) {
          failure = error;
        }
        return { text: "done" };
      },
    },
  });
  const result = await runtime.run("fixture", {
    identity: { tenantId: "tenant", userId: "user" },
    sessionId: "session",
    rootExecution: root,
    recovery,
  });
  if (failure) throw failure;
  expect(result.status).toBe("completed");
}
function response(): ModelResponse {
  return {
    message: { role: "assistant", content: "done" },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
    raw: { secret: "do not persist raw" },
  };
}
function model(generate: ModelProvider["generate"]): ModelProvider {
  return {
    providerId: "offline",
    modelId: "fixture",
    generate,
    async *stream() {
      yield { type: "finish", finishReason: "stop", usage: response().usage };
    },
  };
}

describe("graph recovery execution ports", () => {
  it("reuses authorized pure tool output without another root work attempt", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxConcurrentWork: 1, maxWorkAttempts: 1 });
    let calls = 0;
    let reviews = 0;
    const read = binding(async (args) => {
      calls++;
      return String(args.value);
    });
    await withServices(
      [read],
      root,
      async (base) => {
        const scoped = scopeGraphServices(
          base,
          "episode/read",
          ["read"],
          createGraphRecoveryPorts(f.journal, root, [read]),
          f.journal,
        );
        const call = { id: "stable", name: "read", arguments: { value: 7 } };
        expect((await scoped.dispatch(call)).result).toBe("7");
        expect((await scoped.dispatch(call)).result).toBe("7");
        expect(calls).toBe(1);
        expect(reviews).toBe(2);
        expect(root.snapshot().workAttempts).toBe(1);
        expect(
          Object.values((await f.journal.snapshot()).nodes).some(
            (node) => node.status === "completed" && node.output === "7",
          ),
        ).toBe(true);
      },
      {
        decide: () => {
          reviews++;
          return { action: "allow" };
        },
      },
    );
  });
  it("persists the host tool budget before dispatch through the inherited recovery bridge", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    const saved: number[] = [];
    const read = binding(async () => {
      expect(saved.at(-1)).toBe(1);
      return "saved";
    });
    const ports = createGraphRecoveryPorts(f.journal, root, [read]);
    await withServices(
      [read],
      root,
      async (base) => {
        const scoped = scopeGraphServices(base, "read", ["read"], ports, f.journal);
        expect((await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 7 } })).result).toBe("saved");
        expect(saved).toContain(1);
      },
      undefined,
      {
        persistBudget: async (state) => {
          saved.push(state.usedTools);
        },
        invokeTool: ports.invokeTool,
      },
    );
  });
  it("accepts equivalent Agent-local definitions and rejects weakened approval bindings", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let effects = 0;
    const read = binding(async () => {
      effects++;
      return "saved";
    });
    const ports = createGraphRecoveryPorts(f.journal, root, [read]);
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(base, "agent", ["read"], ports, f.journal);
      const agent = new Agent({
        name: "local",
        model: model(async () => response()),
        tools: [{ ...read.tool }],
        register: false,
      });
      try {
        const local = agent.tools[0];
        expect(
          await scoped.invokeTool?.(
            local,
            { id: "stable", name: "read", arguments: { value: 1 } },
            { value: 1 },
            scoped.ctx,
            () => local.execute({ value: 1 }, scoped.ctx),
          ),
        ).toBe("saved");
        const weakened = { ...local, requiresApproval: true };
        await expect(
          scoped.invokeTool?.(
            weakened,
            { id: "different", name: "read", arguments: { value: 1 } },
            { value: 1 },
            scoped.ctx,
            async () => "unsafe",
          ),
        ).rejects.toBeInstanceOf(DurableGraphJournalError);
        await expect(
          ports.invokeTool(
            weakened,
            { id: "different", name: "read", arguments: { value: 1 } },
            { value: 1 },
            scoped.ctx,
            async () => "unsafe",
          ),
        ).rejects.toBeInstanceOf(DurableGraphJournalError);
        expect(effects).toBe(1);
      } finally {
        await agent.close();
      }
    });
  });
  it("accepts copied finite protection configs while rejecting a changed sandbox grant", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let effects = 0;
    const read = binding(async () => {
      effects++;
      return "saved";
    });
    read.tool.sandbox = { enabled: false, allowFS: { readOnly: ["/approved"] }, env: { MODE: "read" } };
    read.tool.rawJsonSchema = { type: "object", properties: { value: { type: "number" } } };
    const ports = createGraphRecoveryPorts(f.journal, root, [read]);
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(base, "agent", [read.id], ports, f.journal);
      const copied = {
        ...read.tool,
        sandbox: structuredClone(read.tool.sandbox),
        rawJsonSchema: structuredClone(read.tool.rawJsonSchema),
      };
      expect(
        await scoped.invokeTool?.(
          copied,
          { id: "stable", name: "read", arguments: { value: 1 } },
          { value: 1 },
          scoped.ctx,
          async () => {
            effects++;
            return "saved";
          },
        ),
      ).toBe("saved");
      const weakened = {
        ...copied,
        sandbox: { enabled: false, allowFS: { readOnly: ["/approved"] }, env: { MODE: "read" }, allowNetwork: true },
      };
      await expect(
        ports.invokeTool(
          weakened,
          { id: "unsafe", name: "read", arguments: { value: 1 } },
          { value: 1 },
          scoped.ctx,
          async () => "unsafe",
        ),
      ).rejects.toBeInstanceOf(DurableGraphJournalError);
      expect(effects).toBe(1);
    });
  });
  it("replays complete models after a new owner without persisting credentials or raw SDK objects", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxWorkAttempts: 1 });
    let calls = 0;
    const provider = model(async () => {
      calls++;
      return response();
    });
    await withServices([], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "episode/agent",
        [],
        createGraphRecoveryPorts(f.journal, root, []),
        f.journal,
      );
      await scoped.model(provider, [{ role: "user", content: "hello" }], { apiKey: "first-secret", maxTokens: 10 });
      const journal = await f.restart();
      const resumed = scopeGraphServices(
        base,
        "episode/agent",
        [],
        createGraphRecoveryPorts(journal, root, []),
        journal,
      );
      expect(
        (
          await resumed.model(provider, [{ role: "user", content: "hello" }], {
            apiKey: "rotated-secret",
            maxTokens: 10,
          })
        ).message.content,
      ).toBe("done");
      const state = await journal.snapshot();
      expect(Object.keys(state.models)).toEqual(["episode/agent/model/0"]);
      expect(JSON.stringify(state)).not.toContain("secret");
      expect(calls).toBe(1);
      expect(root.snapshot().workAttempts).toBe(1);
    });
  });
  it("dispatches ledger connectors instead of the unsafe raw tool and reuses its confirmed receipt", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxWorkAttempts: 1 });
    let effects = 0;
    const read = binding(async () => {
      throw new Error("Raw effect must not execute");
    });
    const connector: DurableActionConnector = {
      version: "destination/v1",
      async dispatch() {
        effects++;
        return { resultRef: "receipt" };
      },
    };
    read.recovery = { connector, destination: "fixture:destination", resolveResult: async () => "confirmed" };
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "episode/write",
        ["read"],
        createGraphRecoveryPorts(f.journal, root, [read]),
        f.journal,
      );
      const call = { id: "stable", name: "read", arguments: { value: 1 } };
      expect((await scoped.dispatch(call)).result).toBe("confirmed");
      expect((await scoped.dispatch(call)).result).toBe("confirmed");
      expect(effects).toBe(1);
      expect(root.snapshot().workAttempts).toBe(1);
      expect(Object.values((await f.store.get(key))?.actions ?? {})[0].state).toBe("confirmed");
    });
  });
  it("reconciles the originating binding when multiple operations share a connector version and destination", async () => {
    const f = await fixture();
    let effects = 0;
    let reconciledA = 0;
    let reconciledB = 0;
    const a = binding(async () => {
      throw new Error("Raw effect must not execute");
    });
    a.id = "operation-a";
    a.tool = { ...a.tool, name: "operation-a" };
    a.recovery = {
      destination: "fixture:shared",
      connector: {
        version: "shared/v1",
        async dispatch(action) {
          expect(action.args).toEqual({ value: 7 });
          effects++;
          throw new Error("Receipt lost after A was applied");
        },
        async reconcile() {
          reconciledA++;
          return { outcome: "confirmed", resultRef: "receipt-a", evidenceRef: "destination:a" };
        },
      },
      resolveResult: async () => "result-a",
    };
    const b = binding(async () => "unsafe");
    b.id = "operation-b";
    b.tool = { ...b.tool, name: "operation-b" };
    b.recovery = {
      destination: "fixture:shared",
      connector: {
        version: "shared/v1",
        async dispatch() {
          throw new Error("B must never dispatch");
        },
        async reconcile() {
          reconciledB++;
          return { outcome: "confirmed", resultRef: "receipt-b", evidenceRef: "destination:b" };
        },
      },
      resolveResult: async () => "result-b",
    };
    const call = { id: "stable", name: "operation-a", arguments: { value: 7 } };
    const firstRoot = new RootExecutionController({ maxWorkAttempts: 1 });
    await expect(
      withServices([b, a], firstRoot, async (base) => {
        const scoped = scopeGraphServices(
          base,
          "episode/write",
          [a.id],
          createGraphRecoveryPorts(f.journal, firstRoot, [b, a]),
          f.journal,
        );
        await scoped.dispatch(call);
      }),
    ).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
    const journal = await f.restart();
    const action = Object.values((await f.store.get(key))?.actions ?? {})[0];
    expect(action.state).toBe("unknown");
    expect(await resolveGraphEffectBinding(journal, action, [b, a])).toBe(a);
    await expect(resolveGraphEffectBinding(journal, { ...action, args: { value: 8 } }, [b, a])).rejects.toBeInstanceOf(
      DurableGraphJournalError,
    );
    await expect(
      resolveGraphEffectBinding(journal, { ...action, policyRevision: Number.NaN }, [b, a]),
    ).rejects.toBeInstanceOf(DurableGraphJournalError);
    await expect(resolveGraphEffectBinding(journal, action, [b, { ...a, version: "2" }])).rejects.toBeInstanceOf(
      DurableGraphJournalError,
    );
    await expect(resolveGraphEffectBinding(journal, { ...action, id: "unbound" }, [b, a])).rejects.toBeInstanceOf(
      DurableGraphJournalError,
    );
    const resumedRoot = new RootExecutionController({ maxWorkAttempts: 0 });
    await withServices([b, a], resumedRoot, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "episode/write",
        [a.id],
        createGraphRecoveryPorts(journal, resumedRoot, [b, a]),
        journal,
      );
      expect((await scoped.dispatch(call)).result).toBe("result-a");
      expect((await scoped.dispatch(call)).result).toBe("result-a");
    });
    expect({ effects, reconciledA, reconciledB }).toEqual({ effects: 1, reconciledA: 1, reconciledB: 0 });
    expect(resumedRoot.snapshot().workAttempts).toBe(0);
    await expect(
      journal.mutate((state) => {
        const origin = state.evidence.find(
          (row) => row && typeof row === "object" && !Array.isArray(row) && row.type === "effect.origin",
        );
        if (origin && typeof origin === "object" && !Array.isArray(origin)) origin.bindingId = b.id;
      }),
    ).rejects.toBeInstanceOf(DurableGraphJournalError);
  });
  it("fails closed when a ledger action has no persisted graph origin", async () => {
    const f = await fixture();
    const action = await new DurableActionLedger(f.store, key, f.journal.fence).prepare({
      id: "legacy-unbound",
      connectorVersion: "shared/v1",
      destination: "fixture:shared",
      args: { value: 7 },
    });
    await expect(resolveGraphEffectBinding(f.journal, action, [])).rejects.toBeInstanceOf(DurableGraphJournalError);
  });
  it("keeps a failed receipt lookup explicit and admits a proved-absent retry before dispatch", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxWorkAttempts: 1 });
    let effects = 0;
    let absent = false;
    const write = binding(async () => {
      throw new Error("Raw effect must not execute");
    });
    write.recovery = {
      destination: "fixture:destination",
      connector: {
        version: "destination/v1",
        async dispatch() {
          effects++;
          throw new Error("Lost acknowledgement");
        },
        async reconcile() {
          if (!absent) throw new Error("Receipt lookup unavailable");
          return { outcome: "absent", evidenceRef: "destination:proved-absent" };
        },
      },
      resolveResult: async () => "confirmed",
    };
    const call = { id: "stable", name: "read", arguments: { value: 7 } };
    await withServices([write], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "episode/write",
        [write.id],
        createGraphRecoveryPorts(f.journal, root, [write]),
        f.journal,
      );
      await expect(scoped.dispatch(call)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
      await expect(scoped.dispatch(call)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
      expect(Object.values((await f.store.get(key))?.actions ?? {})[0].state).toBe("unknown");
    });
    absent = true;
    const resumedRoot = new RootExecutionController({ maxWorkAttempts: 0 });
    await expect(
      withServices([write], resumedRoot, async (base) => {
        const scoped = scopeGraphServices(
          base,
          "episode/write",
          [write.id],
          createGraphRecoveryPorts(f.journal, resumedRoot, [write]),
          f.journal,
        );
        await scoped.dispatch(call);
      }),
    ).rejects.toMatchObject({ code: "root_attempt_limit" });
    expect(Object.values((await f.store.get(key))?.actions ?? {})[0].state).toBe("prepared");
    expect(effects).toBe(1);
    expect(resumedRoot.snapshot().workAttempts).toBe(0);
  });
  it.each(["zero-attempt-allowance", "cancel-before-admission"])(
    "keeps %s effects known not dispatched",
    async (scenario) => {
      const f = await fixture();
      const cancellation = new AbortController();
      const root = new RootExecutionController(
        { maxWorkAttempts: scenario === "zero-attempt-allowance" ? 0 : 1 },
        {
          signal: cancellation.signal,
          onEvent: (event) => {
            if (scenario === "cancel-before-admission" && event.type === "queued")
              cancellation.abort("before dispatch");
          },
        },
      );
      let effects = 0;
      const write = binding(async () => {
        throw new Error("Raw effect must not execute");
      });
      write.recovery = {
        destination: "fixture:destination",
        connector: {
          version: "destination/v1",
          async dispatch() {
            effects++;
            return { resultRef: "receipt" };
          },
        },
        resolveResult: async () => "confirmed",
      };
      await expect(
        withServices([write], root, async (base) => {
          const scoped = scopeGraphServices(
            base,
            "episode/write",
            [write.id],
            createGraphRecoveryPorts(f.journal, root, [write]),
            f.journal,
          );
          await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 7 } });
        }),
      ).rejects.toBeInstanceOf(RootExecutionError);
      const actions = Object.values((await f.store.get(key))?.actions ?? {});
      expect(actions).toHaveLength(1);
      expect(actions[0].state).toBe("prepared");
      expect(actions[0].dispatchFence).toBeUndefined();
      expect(effects).toBe(0);
      expect(root.snapshot()).toMatchObject({ workAttempts: 0, active: 0 });
    },
  );
  it("holds one leaf permit through receipt settlement and blocks nested connector dispatch", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxConcurrentWork: 1, maxWorkAttempts: 1 });
    const write = binding(async () => {
      throw new Error("Raw effect must not execute");
    });
    let nestedCalls = 0;
    write.recovery = {
      destination: "fixture:destination",
      connector: {
        version: "destination/v1",
        async dispatch() {
          expect(root.snapshot().active).toBe(1);
          await expect(
            root.run("tool", "nested", async () => {
              nestedCalls++;
            }),
          ).rejects.toMatchObject({ code: "root_nested_leaf" });
          return { resultRef: "receipt" };
        },
      },
      async resolveResult() {
        expect(root.snapshot().active).toBe(1);
        expect(Object.values((await f.store.get(key))?.actions ?? {})[0].state).toBe("confirmed");
        return "confirmed";
      },
    };
    await withServices([write], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "episode/write",
        [write.id],
        createGraphRecoveryPorts(f.journal, root, [write]),
        f.journal,
      );
      expect((await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 7 } })).result).toBe("confirmed");
    });
    expect(nestedCalls).toBe(0);
    expect(root.snapshot()).toMatchObject({ workAttempts: 1, active: 0 });
  });
  it("preserves numeric-looking strings while decoding schema-approved JSON output", () => {
    const read = binding(async () => "7");
    expect(graphToolOutput(read, "7")).toBe("7");
    read.output = z.object({ value: z.number() }).transform((value) => ({ value: value.value + 1 }));
    expect(graphToolOutput(read, { content: '{"value":7}' })).toEqual({ value: 8 });
  });
  it("runs an Agent through complete recorded model/tool decisions and replays after replacement", async () => {
    const f = await fixture();
    const root = new RootExecutionController({ maxConcurrentWork: 1, maxWorkAttempts: 3 });
    let models = 0;
    let tools = 0;
    const read = binding(async () => {
      tools++;
      const state = await f.journal.snapshot();
      expect(state.models["agent/model/0"].status).toBe("completed");
      return "7";
    });
    const provider = model(async () => {
      models++;
      return models === 1
        ? {
            ...response(),
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "stable", name: "read", arguments: { value: 7 } }],
            },
            finishReason: "tool_calls",
          }
        : response();
    });
    await withServices([read], root, async (base) => {
      async function run(journal: DurableGraphJournal) {
        const scoped = scopeGraphServices(
          base,
          "agent",
          ["read"],
          createGraphRecoveryPorts(journal, root, [read]),
          journal,
        );
        const agent = new Agent({
          name: "fixture",
          model: provider,
          instructions: "Read",
          maxTokens: 10,
          maxToolRoundtrips: 2,
          register: false,
        });
        try {
          return await agent.run("hello", {
            executionServices: scoped,
            history: [],
            runId: "agent",
            sessionId: "session",
          });
        } finally {
          await agent.close();
        }
      }
      expect((await run(f.journal)).text).toBe("done");
      expect((await run(await f.restart())).text).toBe("done");
      expect(models).toBe(2);
      expect(tools).toBe(1);
      expect(root.snapshot().workAttempts).toBe(3);
    });
  });
  it("rejects changed arguments under one logical call before another dispatch", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let calls = 0;
    const read = binding(async () => {
      calls++;
      return "saved";
    });
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "read",
        ["read"],
        createGraphRecoveryPorts(f.journal, root, [read]),
        f.journal,
      );
      await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 1 } });
      await expect(scoped.dispatch({ id: "stable", name: "read", arguments: { value: 2 } })).rejects.toThrow(
        /mismatch|input/i,
      );
      expect(calls).toBe(1);
    });
  });
  it("runs host authorization before journal lookup and rejects tools outside node scope", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let calls = 0;
    const read = binding(async () => {
      calls++;
      return "read";
    });
    await withServices(
      [read],
      root,
      async (base) => {
        const scoped = scopeGraphServices(
          base,
          "read",
          ["read"],
          createGraphRecoveryPorts(f.journal, root, [read]),
          f.journal,
        );
        expect((await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 1 } })).denial).toBe("policy");
        expect((await f.journal.snapshot()).nodes).toEqual({});
        expect(calls).toBe(0);
        expect(root.snapshot().workAttempts).toBe(0);
        const empty = scopeGraphServices(
          base,
          "other",
          [],
          createGraphRecoveryPorts(f.journal, root, [read]),
          f.journal,
        );
        expect((await empty.dispatch({ id: "other", name: "read", arguments: { value: 1 } })).error).toMatch(
          /not found/i,
        );
      },
      { decide: () => ({ action: "deny", reason: "host denied" }) },
    );
  });
  it("retains unknown effect outcomes and never redispatches them without evidence", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let dispatches = 0;
    const read = binding(async () => {
      throw new Error("unsafe raw");
    });
    read.recovery = {
      destination: "write",
      connector: {
        version: "write/1",
        async dispatch() {
          dispatches++;
          throw new Error("lost acknowledgement");
        },
        reconcile: async () => ({ outcome: "unknown", evidenceRef: "not proven" }),
      },
      resolveResult: async () => "unused",
    };
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "write",
        ["read"],
        createGraphRecoveryPorts(f.journal, root, [read]),
        f.journal,
      );
      const call = { id: "stable", name: "read", arguments: { value: 1 } };
      await expect(scoped.dispatch(call)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
      await expect(scoped.dispatch(call)).rejects.toBeInstanceOf(DurableRecoveryRequiredError);
      expect(dispatches).toBe(1);
      expect(Object.values((await f.store.get(key))?.actions ?? {})[0].state).toBe("unknown");
    });
  });
  it("keeps original tool results across output transforms and validates parsed argument identity", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let executed: unknown;
    const parameters = z.object({ value: z.string().transform(Number) });
    const read: GraphToolBinding = {
      id: "read",
      version: "1",
      kind: "tool",
      input: parameters,
      output: z.object({ value: z.number() }).transform((value) => ({ value: value.value + 1 })),
      recovery: "pure",
      tool: {
        name: "read",
        description: "read",
        parameters,
        execute: async (args) => {
          executed = args;
          return { content: JSON.stringify(args) };
        },
      },
    };
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "transform",
        ["read"],
        createGraphRecoveryPorts(f.journal, root, [read]),
        f.journal,
      );
      const result = await scoped.dispatch({ id: "stable", name: "read", arguments: { value: "7" } });
      expect(executed).toEqual({ value: 7 });
      expect(result.result).toEqual({ content: '{"value":7}' });
      expect(graphToolOutput(read, result.result)).toEqual({ value: 8 });
      const record = Object.values((await f.journal.snapshot()).nodes)[0];
      expect(record.input).toEqual({ value: 7 });
      expect(record.output).toEqual({ content: '{"value":7}' });
    });
  });
  it("represents a resolver domain object with a content field as JSON unless it is a ToolResult", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    const read = binding(async () => {
      throw new Error("Unsafe raw tool");
    });
    read.output = z.object({ content: z.string(), value: z.number() }).strict();
    read.recovery = {
      destination: "domain",
      connector: { version: "domain/1", dispatch: async () => ({ resultRef: "receipt" }) },
      resolveResult: async () => ({ content: "domain text", value: 7 }),
    };
    await withServices([read], root, async (base) => {
      const scoped = scopeGraphServices(
        base,
        "write",
        ["read"],
        createGraphRecoveryPorts(f.journal, root, [read]),
        f.journal,
      );
      const result = await scoped.dispatch({ id: "stable", name: "read", arguments: { value: 7 } });
      expect(result.error).toBeUndefined();
      expect(graphToolOutput(read, result.result)).toEqual({ content: "domain text", value: 7 });
    });
  });
  it.each(["unknownExtras", "duplicateCalls", "missingCalls", "incoherentUsage"])(
    "rejects unsupported model evidence: %s",
    async (kind) => {
      const f = await fixture();
      const root = new RootExecutionController();
      const answer = response();
      if (kind === "unknownExtras") answer.message.providerExtras = { opaqueContinuation: "host-handle" };
      if (kind === "duplicateCalls") {
        answer.message.toolCalls = [
          { id: "dup", name: "read", arguments: {} },
          { id: "dup", name: "read", arguments: {} },
        ];
        answer.finishReason = "tool_calls";
      }
      if (kind === "missingCalls") answer.finishReason = "tool_calls";
      if (kind === "incoherentUsage") answer.usage.totalTokens = 1;
      await withServices([], root, async (base) => {
        const scoped = scopeGraphServices(base, "agent", [], createGraphRecoveryPorts(f.journal, root, []), f.journal);
        await expect(
          scoped.model(
            model(async () => answer),
            [{ role: "user", content: "hello" }],
            { maxTokens: 10 },
          ),
        ).rejects.toThrow();
        expect(
          Object.values((await f.journal.snapshot()).models).every((record) => record.status !== "completed"),
        ).toBe(true);
      });
    },
  );
  it("preserves supported finite provider replay and rejects credentials in ownership", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    const answer = response();
    answer.message.providerExtras = {
      responsesReplay: {
        version: 1,
        owner: "https://example.test/v1",
        model: "fixture",
        items: [{ type: "reasoning", encrypted_content: "signature" }],
      },
    };
    await withServices([], root, async (base) => {
      const scoped = scopeGraphServices(base, "agent", [], createGraphRecoveryPorts(f.journal, root, []), f.journal);
      expect(
        (
          await scoped.model(
            model(async () => answer),
            [{ role: "user", content: "hello" }],
            { maxTokens: 10 },
          )
        ).message.providerExtras,
      ).toEqual(answer.message.providerExtras);
      answer.message.providerExtras = {
        responsesReplay: { version: 1, owner: "https://user:secret@example.test/v1?key=secret", items: [] },
      };
      await expect(
        scoped.model(
          model(async () => answer),
          [{ role: "user", content: "another" }],
          { maxTokens: 10 },
        ),
      ).rejects.toThrow();
    });
  });
  it("binds recorded models to requests/provider identity and forbids unrecorded Agent streaming", async () => {
    const f = await fixture();
    const root = new RootExecutionController();
    let calls = 0;
    const provider = model(async () => {
      calls++;
      return response();
    });
    await withServices([], root, async (base) => {
      const ports = createGraphRecoveryPorts(f.journal, root, []);
      const scoped = scopeGraphServices(base, "agent", [], ports, f.journal);
      expect(scoped.ctx.runId).toBe("agent");
      expect(() => {
        scoped.ctx.metadata.executionGraphNodeId = "other";
      }).toThrow();
      await scoped.model(provider, [{ role: "user", content: "hello" }], { maxTokens: 10 });
      const changed = scopeGraphServices(base, "agent", [], ports, f.journal);
      await expect(
        changed.model(provider, [{ role: "user", content: "different" }], { maxTokens: 10 }),
      ).rejects.toBeInstanceOf(DurableGraphJournalError);
      const iterator = scoped.streamModel(provider, []);
      await expect(iterator.next()).rejects.toThrow(/streaming/i);
      expect(calls).toBe(1);
    });
  });
});
