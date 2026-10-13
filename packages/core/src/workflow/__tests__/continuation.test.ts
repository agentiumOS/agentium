import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Agent } from "../../agent/agent.js";
import type { ExecutionServices } from "../../agent/execution-services.js";
import { getAccountingContext } from "../../cost/context.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { StorageBackedCheckpointStore, type WorkflowCheckpoint, type WorkflowCheckpointStore } from "../checkpoints.js";
import type { WorkflowConfig } from "../types.js";
import { Workflow } from "../workflow.js";

const stateSchema = z.object({ total: z.number(), log: z.array(z.string()) }).strict();
type State = z.infer<typeof stateSchema>;
function referenceStore<T>(): WorkflowCheckpointStore<T> {
  const records = new Map<string, WorkflowCheckpoint<T>>();
  return {
    async save(cp) {
      records.set(cp.id, cp);
    },
    async load(id) {
      return records.get(id) ?? null;
    },
    async listForRun(runId) {
      return [...records.values()].filter((cp) => cp.runId === runId);
    },
    async delete(id) {
      records.delete(id);
    },
  };
}
function setup() {
  const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
  const effects = vi.fn();
  const config: WorkflowConfig<State> = {
    name: "versioned",
    register: false,
    initialState: { total: 0, log: [] },
    checkpointStore: store,
    definitionVersion: "v1",
    validateCheckpointState: (value) => stateSchema.parse(value),
    steps: [1, 10, 100].map((delta, index) => ({
      name: `add-${index}`,
      run: async (state) => {
        effects();
        return { total: state.total + delta, log: [...state.log, `add-${index}`] };
      },
    })),
  };
  return { store, effects, config, workflow: new Workflow(config) };
}
async function afterFirst(workflow: Workflow<State>, store: WorkflowCheckpointStore<State>) {
  const initial = await workflow.runWithCheckpoints();
  const checkpoint = (await store.listForRun(initial.runId)).find((item) => item.stepIndex === 0);
  if (!checkpoint) throw new Error("Missing first checkpoint");
  return checkpoint;
}

describe("Workflow definition-bound continuation", () => {
  it("keeps absolute cursors, cumulative results and lineage across repeated continuation", async () => {
    const { workflow, store } = setup();
    const first = await afterFirst(workflow, store);
    const second = await workflow.continueFromCheckpoint(first.id);
    const checkpoints = await store.listForRun(second.runId);
    expect(checkpoints.map((cp) => cp.stepIndex)).toEqual([1, 2]);
    expect(checkpoints[0]).toMatchObject({
      formatVersion: 2,
      definitionVersion: "v1",
      stepNames: ["add-0", "add-1", "add-2"],
      parentCheckpointId: first.id,
      parentRunId: first.runId,
    });
    expect(checkpoints[0].stepResults.map((item) => item.stepName)).toEqual(["add-0", "add-1"]);
    const third = await workflow.continueFromCheckpoint(checkpoints[0].id);
    expect(third.state.total).toBe(111);
    expect(third.stepResults.map((item) => item.stepName)).toEqual(["add-0", "add-1", "add-2"]);
  });

  it.each([
    ["name", { workflowName: "other" }],
    ["version", { definitionVersion: "v2" }],
    ["order", { stepNames: ["add-1", "add-0", "add-2"] }],
    ["cursor", { stepIndex: 99 }],
    ["step-name", { stepName: "wrong" }],
    ["legacy", { formatVersion: undefined }],
    ["state", { state: { total: "invalid", log: [] } }],
    ["results", { stepResults: "invalid" }],
  ])("rejects incompatible %s before any effect", async (_label, patch) => {
    const { workflow, store, effects } = setup();
    const cp = await afterFirst(workflow, store);
    await store.save({ ...cp, ...patch } as WorkflowCheckpoint<State>);
    effects.mockClear();
    await expect(workflow.continueFromCheckpoint(cp.id)).rejects.toMatchObject({ code: "checkpoint_incompatible" });
    expect(effects).not.toHaveBeenCalled();
  });

  it("requires the definition version and validator together", () => {
    const { config } = setup();
    expect(() => new Workflow({ ...config, validateCheckpointState: undefined })).toThrow(/together/);
    expect(() => new Workflow({ ...config, definitionVersion: undefined })).toThrow(/together/);
  });

  it("keeps legacy wrapper acceptance, repairs cursors and rejects wrong workflow", async () => {
    const { config, store } = setup();
    const workflow = new Workflow({ ...config, definitionVersion: undefined, validateCheckpointState: undefined });
    const cp = await afterFirst(workflow, store);
    await expect(workflow.continueFromCheckpoint(cp.id)).rejects.toMatchObject({ code: "checkpoint_incompatible" });
    const second = await workflow.replay(cp.id);
    const checkpoints = await store.listForRun(second.runId);
    expect(checkpoints.map((item) => item.stepIndex)).toEqual([1, 2]);
    expect((await workflow.replay(checkpoints[0].id)).state.total).toBe(111);
    await store.save({ ...cp, workflowName: "other" });
    await expect(workflow.replay(cp.id)).rejects.toMatchObject({ code: "checkpoint_incompatible" });
  });

  it("allows explicit host migration after validating original identity and state", async () => {
    const { config, store } = setup();
    const legacy = new Workflow({ ...config, definitionVersion: undefined, validateCheckpointState: undefined });
    const cp = await afterFirst(legacy, store);
    expect(cp.workflowName).toBe(config.name);
    expect(config.steps[cp.stepIndex]?.name).toBe(cp.stepName);
    await store.save({
      ...cp,
      state: stateSchema.parse(cp.state),
      formatVersion: 2,
      definitionVersion: "v1",
      stepNames: config.steps.map((step) => step.name),
    });
    expect((await new Workflow(config).continueFromCheckpoint(cp.id)).state.total).toBe(111);
  });

  it("clones saved snapshots and restored state before fork mutations", async () => {
    const { config } = setup();
    const store = referenceStore<State>();
    const workflow = new Workflow({ ...config, checkpointStore: store });
    const cp = await afterFirst(workflow, store);
    await workflow.fork(cp.id, (state) => {
      state.log.push("fork");
      return { total: 50 };
    });
    expect((await store.load(cp.id))?.state.log).toEqual(["add-0"]);
    const initial = await workflow.runWithCheckpoints();
    initial.state.log.push("after-result");
    expect((await store.listForRun(initial.runId))[2].state.log).not.toContain("after-result");
  });

  it("forwards caller identity, policy and child-supported options", async () => {
    const { config, store, workflow } = setup();
    const cp = await afterFirst(workflow, store);
    const run = vi.fn().mockResolvedValue({ text: "ok", status: "completed" });
    const agent = { run } as unknown as Agent;
    const seen = vi.fn();
    const next = new Workflow({
      ...config,
      steps: [
        config.steps[0],
        {
          name: "add-1",
          run: async (_state, ctx) => {
            seen(ctx);
            return {};
          },
        },
        { name: "add-2", agent },
      ],
    });
    const controller = new AbortController();
    const executionPolicy = { decide: () => ({ action: "allow" as const }) };
    const executionServices = {
      executionPolicy,
      dispatchEffect: async (
        _name: string,
        args: Record<string, unknown>,
        execute: (args: Record<string, unknown>) => Promise<unknown>,
      ) => execute(args),
    } as unknown as ExecutionServices;
    const dependencies = { token: "value" };
    await next.continueFromCheckpoint(cp.id, {
      sessionId: "new-session",
      userId: "user",
      tenantId: "tenant",
      runId: "new-run",
      metadata: { test: 1 },
      signal: controller.signal,
      executionServices,
      executionPolicy,
      runMode: "plan",
      apiKey: "local-key",
      dependencies,
    });
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "new-session",
        userId: "user",
        tenantId: "tenant",
        runId: "new-run",
        signal: controller.signal,
        executionServices,
        runMode: "plan",
        executionPolicy,
        metadata: { test: 1 },
      }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        sessionId: "new-session:add-2",
        userId: "user",
        tenantId: "tenant",
        signal: controller.signal,
        executionServices,
        runMode: "plan",
        apiKey: "local-key",
        dependencies,
        metadata: { test: 1, parentRunId: "new-run" },
      }),
    );
  });

  it("uses caller identity in continuation accounting scope", async () => {
    const { workflow, config, store } = setup();
    const cp = await afterFirst(workflow, store);
    const scopes = vi.fn();
    const next = new Workflow({
      ...config,
      cost: true,
      steps: config.steps.map((step) => ({
        name: step.name,
        run: async () => {
          scopes(getAccountingContext());
          return {};
        },
      })),
    });
    const result = await next.continueFromCheckpoint(cp.id, {
      runId: "accounted",
      tenantId: "tenant",
      sessionId: "session",
      userId: "user",
    });
    expect(scopes).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "accounted",
        rootRunId: "accounted",
        tenantId: "tenant",
        userId: "user",
        sessionId: "session",
        purpose: "workflow-step",
      }),
    );
    expect(result.costs).toBeDefined();
    await next.close();
  });

  it("rejects noncloneable validated restored state before dispatch", async () => {
    const { config, store, workflow, effects } = setup();
    const cp = await afterFirst(workflow, store);
    effects.mockClear();
    const next = new Workflow<Record<string, unknown>>({
      ...config,
      steps: config.steps.map((step) => ({
        name: step.name,
        run: async () => {
          effects();
          return {};
        },
      })),
      validateCheckpointState: () => ({ opaque: () => {} }),
    });
    await expect(next.continueFromCheckpoint(cp.id)).rejects.toMatchObject({ code: "checkpoint_incompatible" });
    expect(effects).not.toHaveBeenCalled();
  });

  it("retains callable legacy state and independently clones ordinary nested containers", async () => {
    const store = referenceStore<{ callable: () => string; nested: { count: number } }>();
    const callable = () => "legacy";
    const workflow = new Workflow({
      name: "legacy-callable",
      register: false,
      checkpointStore: store,
      initialState: { callable, nested: { count: 0 } },
      steps: [
        { name: "a", run: async () => ({}) },
        { name: "b", run: async () => ({}) },
      ],
    });
    const first = await workflow.runWithCheckpoints();
    const cp = (await store.listForRun(first.runId))[0];
    const result = await workflow.fork(cp.id, (state) => {
      state.nested.count = 7;
      return {};
    });
    expect(result.state.callable()).toBe("legacy");
    expect((await store.load(cp.id))?.state.nested).toEqual({ count: 0 });
  });

  it("keeps legacy wrapper step-name compatibility while strict v2 validates it", async () => {
    const { config, store } = setup();
    const workflow = new Workflow({ ...config, definitionVersion: undefined, validateCheckpointState: undefined });
    const cp = await afterFirst(workflow, store);
    await store.save({ ...cp, stepName: "legacy-renamed" });
    expect((await workflow.replay(cp.id)).state.total).toBe(111);
  });

  it("never saves a checkpoint for a late patch after known cancellation", async () => {
    const { config, store } = setup();
    const controller = new AbortController();
    const save = vi.spyOn(store, "save");
    const workflow = new Workflow({
      ...config,
      steps: [
        {
          name: "abort",
          run: async () => {
            controller.abort(new Error("cancelled"));
            return { total: 99 };
          },
        },
      ],
    });
    await expect(workflow.runWithCheckpoints({ signal: controller.signal })).rejects.toThrow("cancelled");
    expect(save).not.toHaveBeenCalled();
  });

  it("stops before the next effect after checkpoint save failure", async () => {
    const { config, effects } = setup();
    const save = vi.fn().mockRejectedValue(new Error("write lost"));
    const workflow = new Workflow({
      ...config,
      checkpointStore: { save, load: async () => null, listForRun: async () => [], delete: async () => {} },
    });
    await expect(workflow.runWithCheckpoints()).rejects.toThrow("write lost");
    expect(effects).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
});
