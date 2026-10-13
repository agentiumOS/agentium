import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  type DurableActionConnector,
  type DurableDocumentCollection,
  type DurableJSON,
  type DurableTaskRecord,
  type DurableTaskStore,
  type ModelProvider,
  MongoDBDurableDocumentConnector,
  MongoDBDurableTaskStore,
} from "@agentium/core";
import { z } from "zod/v3";
import { ExecutionGraphRuntime } from "../../execution-graph.js";
import type { ExecutionGraphProgram, ExecutionPlan, GraphBinding } from "../../graph-contracts.js";

export const fixtureCaseSchema = z.enum(["single", "siblings", "budget-limit", "repeat", "agent", "stream"]);
export const fixturePhaseSchema = z.enum([
  "none",
  "before-dispatch",
  "remote-accepted",
  "unresolved-intent",
  "receipt-saved",
  "sibling-complete",
  "repeat-decision",
  "plan-committed",
]);
export type FixtureCase = z.infer<typeof fixtureCaseSchema>;
export type FixturePhase = z.infer<typeof fixturePhaseSchema>;
export const workerMessageSchema = z.object({
  kind: z.enum(["barrier", "result", "error"]),
  taskId: z.string(),
  phase: fixturePhaseSchema,
  pid: z.number().int().positive(),
  error: z.string().optional(),
});
const graphProbeSchema = z
  .object({
    nodes: z.record(
      z
        .object({
          binding: z.object({ id: z.string(), kind: z.string() }),
          status: z.string(),
          input: z.unknown().optional(),
          output: z.unknown().optional(),
        })
        .passthrough(),
    ),
    plans: z.record(z.unknown()),
    decisions: z.record(z.unknown()),
  })
  .passthrough();
const effectInput = z.object({ label: z.string(), taskId: z.string() });
const extension = "agentium.graph.v1";
const destination = "graph-fixture-inbox";

interface FixtureOptions {
  taskId: string;
  scenario: FixtureCase;
  store: DurableTaskStore;
  receipts: DurableDocumentCollection;
  phase?: FixturePhase;
  observe?: (operation: string, details?: Record<string, DurableJSON>) => Promise<void>;
  barrier?: (phase: FixturePhase, task: DurableTaskRecord) => Promise<never>;
}

/** The same catalog/versions are reconstructed in each independent process.
 * Barriers run only after real acknowledged storage/connector operations. */
export function graphFixtureRuntime(options: FixtureOptions): ExecutionGraphRuntime {
  const { taskId, scenario, receipts } = options;
  const phase = options.phase ?? "none";
  const observe = options.observe ?? (async () => {});
  let fired = false;
  const stop = async (record: DurableTaskRecord) => {
    if (fired || !options.barrier) return;
    fired = true;
    await options.barrier(phase, record);
  };
  const store: DurableTaskStore = {
    capabilities: options.store.capabilities,
    create: (input) => options.store.create(input),
    get: (key) => options.store.get(key),
    update: async (key, mutate, guard) => {
      let startedSend = false;
      let startedRight = false;
      let completedLeft = false;
      let confirmedReceipt = false;
      let committedDecision = false;
      let committedPlan = false;
      const record = await options.store.update(
        key,
        (draft, now) => {
          const before = graphProbeSchema.safeParse(draft.extensions[extension]);
          const actionStates = new Map(Object.entries(draft.actions).map(([id, action]) => [id, action.state]));
          mutate(draft, now);
          const after = graphProbeSchema.safeParse(draft.extensions[extension]);
          const started = after.success
            ? Object.entries(after.data.nodes).filter(
                ([id, node]) =>
                  node.binding.id === "send" &&
                  node.status === "running" &&
                  (!before.success || before.data.nodes[id]?.status !== "running"),
              )
            : [];
          startedSend = started.length > 0;
          startedRight = started.some(
            ([, node]) => effectInput.safeParse(node.input).success && effectInput.parse(node.input).label === "right",
          );
          completedLeft =
            after.success &&
            Object.entries(after.data.nodes).some(
              ([id, node]) =>
                node.binding.id === "send" &&
                node.status === "completed" &&
                node.output === "left" &&
                (!before.success || before.data.nodes[id]?.status !== "completed"),
            );
          confirmedReceipt = Object.entries(draft.actions).some(
            ([id, action]) => action.state === "confirmed" && actionStates.get(id) !== "confirmed",
          );
          committedDecision =
            after.success &&
            Object.keys(after.data.decisions).length > (before.success ? Object.keys(before.data.decisions).length : 0);
          committedPlan =
            after.success &&
            Object.keys(after.data.plans).length > (before.success ? Object.keys(before.data.plans).length : 0);
        },
        guard,
      );
      const parsed = graphProbeSchema.safeParse(record.extensions[extension]);
      if (!parsed.success || fired || phase === "none") return record;
      const graph = parsed.data;
      const nodes = Object.values(graph.nodes).filter((node) => node.binding.id === "send");
      const completed = nodes.filter((node) => node.status === "completed");
      const running = nodes.filter((node) => node.status === "running");
      if (phase === "before-dispatch" && startedSend && !Object.keys(record.actions).length) {
        await stop(record);
      } else if (phase === "receipt-saved" && running.length && confirmedReceipt) {
        await stop(record);
      } else if (phase === "sibling-complete") {
        if (completedLeft && running.length) await stop(record);
        // Delay the right sibling before action preparation, leaving it safe to
        // restart. The left sibling continues and publishes the actual barrier.
        if (startedRight) {
          await new Promise<never>(() => {});
        }
      } else if (phase === "repeat-decision" && completed.length === 1 && committedDecision) {
        await stop(record);
      } else if (phase === "plan-committed" && committedPlan) {
        await stop(record);
      }
      return record;
    },
  };
  const realConnector = new MongoDBDurableDocumentConnector(receipts, destination);
  const connector: DurableActionConnector = {
    version: realConnector.version,
    dispatch: async (action, signal) => {
      await observe("dispatch", { actionId: action.id, idempotencyKey: action.idempotencyKey });
      if (phase === "unresolved-intent" && !fired) {
        const record = await options.store.get({ tenantId: "tenant", taskId });
        if (!record) throw new Error("Fixture task disappeared after dispatch intent");
        await stop(record);
      }
      const receipt = await realConnector.dispatch(action, signal);
      if (phase === "remote-accepted" && !fired) {
        const record = await options.store.get({ tenantId: "tenant", taskId });
        if (!record) throw new Error("Fixture task disappeared after destination acceptance");
        await stop(record);
      }
      return receipt;
    },
    reconcile: (action) => realConnector.reconcile(action),
  };
  const send: GraphBinding = {
    id: "send",
    version: "fixture@1",
    kind: "tool",
    input: effectInput,
    output: z.string(),
    tool: {
      name: "send",
      description: "Append one acknowledged test-owned MongoDB receipt",
      parameters: effectInput,
      execute: async () => {
        throw new Error("Effect must dispatch through the durable connector");
      },
    },
    recovery: {
      connector,
      destination,
      resolveResult: async (resultRef) => {
        const prefix = "mongodb-document:";
        if (!resultRef.startsWith(prefix)) throw new Error("Unexpected fixture result reference");
        const receipt = await receipts.findOne({ _id: resultRef.slice(prefix.length) });
        if (!receipt) throw new Error("Acknowledged fixture receipt is missing");
        return effectInput.parse(receipt.value).label;
      },
    },
  };
  const plan = (labels: readonly string[]): ExecutionPlan => ({
    schemaVersion: 1,
    revision: 1,
    maxConcurrency: 2,
    nodes: labels.map((label) => ({ id: label, binding: "send", version: "fixture@1", args: { label, taskId } })),
  });
  const catalog: GraphBinding[] = [send];
  let program: ExecutionGraphProgram = { id: `mongo-${scenario}`, version: "fixture@1", plan: plan(["single"]) };
  if (scenario === "siblings" || scenario === "budget-limit") {
    program = { ...program, plan: plan(["left", "right"]) };
  } else if (scenario === "repeat") {
    catalog.push({
      id: "repeat",
      version: "fixture@1",
      kind: "repeat",
      input: z.object({}),
      output: z.unknown(),
      maxIterations: 2,
      program: { id: "repeat-child", version: "fixture@1", plan: plan(["iteration"]) },
      while: (_output, completedIterations) => completedIterations < 2,
    });
    program = {
      ...program,
      plan: {
        schemaVersion: 1,
        revision: 1,
        nodes: [{ id: "repeat", binding: "repeat", version: "fixture@1", args: {} }],
      },
    };
  } else if (scenario === "agent") {
    const provider: ModelProvider = {
      providerId: "offline-mongo-fixture",
      modelId: "recorded-agent@1",
      generate: async (messages) => {
        const finished = messages.some((message) => message.role === "tool");
        await observe("model", { finished });
        return {
          message: {
            role: "assistant",
            content: finished ? "agent done" : null,
            ...(!finished
              ? {
                  toolCalls: [{ id: "stable-send", name: "send", arguments: { label: "agent", taskId } }],
                }
              : {}),
          },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: finished ? "stop" : "tool_calls",
          raw: null,
        };
      },
      // biome-ignore lint/correctness/useYield: wrong-path calls must fail, never emit a valid fixture response.
      async *stream() {
        throw new Error("Agent fixture uses complete recorded responses");
      },
    };
    catalog.push({
      id: "agent",
      version: "fixture@1",
      kind: "agent",
      input: z.object({}),
      output: z.object({ text: z.string() }).passthrough(),
      tools: ["send"],
      agent: new Agent({
        name: "mongo-agent",
        model: provider,
        instructions: "Use send once, then finish",
        maxTokens: 10,
        maxToolRoundtrips: 2,
        register: false,
      }),
    });
    program = {
      ...program,
      plan: {
        schemaVersion: 1,
        revision: 1,
        nodes: [{ id: "agent", binding: "agent", version: "fixture@1", args: {} }],
      },
    };
  } else if (scenario === "stream") {
    const provider: ModelProvider = {
      providerId: "offline-mongo-fixture",
      modelId: "committed-plan@1",
      generate: async () => {
        throw new Error("Planning fixture requires streaming");
      },
      async *stream() {
        const current = await options.store.get({ tenantId: "tenant", taskId });
        const parsed = graphProbeSchema.safeParse(current?.extensions[extension]);
        const revision = parsed.success ? Object.keys(parsed.data.plans).length : 0;
        await observe("planner", { revision });
        // Recovery continues from the retained prefix; it does not regenerate it.
        if (revision === 0)
          yield { type: "text", text: `${JSON.stringify({ baseRevision: 0, plan: plan(["streamed"]) })}\n` };
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    };
    program = {
      id: "mongo-stream",
      version: "fixture@1",
      planner: {
        mode: "stream",
        provider,
        hostInstructions: "Commit only approved fixture work",
        maxCorrections: 1,
        maxOutputTokens: 128,
        stream: { maxFrameBytes: 8192, maxTotalBytes: 16384, maxFrames: 4 },
      },
    };
  }
  return new ExecutionGraphRuntime({
    program,
    catalog,
    store,
    requireDurable: true,
    leaseMs: 400,
    pollMs: 50,
    limits: {
      maxConcurrentWork: scenario === "siblings" ? 2 : 1,
      maxExpandedNodes: 10,
      maxWorkAttempts: 10,
      maxPlanRevisions: 5,
    },
    harness: {
      grants: { toolIds: ["send"], modelRoles: ["main"] },
      budgets: { maxToolCalls: scenario === "budget-limit" ? 1 : 4, maxModelCalls: 4, maxTokens: 500 },
      estimateInputTokens: () => 1,
    },
  });
}

async function workerMain() {
  const args = z
    .tuple([
      z.string().startsWith("mongodb://127.0.0.1:27319/"),
      z.string().startsWith("agentium_graph_fixture_"),
      z.string(),
      fixtureCaseSchema,
      fixturePhaseSchema,
    ])
    .parse(process.argv.slice(2));
  const [uri, database, taskId, scenario, phase] = args;
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  const store = new MongoDBDurableTaskStore(uri, { database });
  await Promise.all([client.connect(), store.initialize()]);
  const collection = client.db(database).collection("effects");
  const receipts: DurableDocumentCollection = {
    updateOne: (filter, update, options) => collection.updateOne(filter, update, options),
    findOne: (filter) => collection.findOne(filter),
  };
  const notify = async (kind: "barrier" | "result" | "error", error?: string) => {
    await new Promise<void>((done, reject) => {
      if (!process.send) return reject(new Error("Fixture requires an IPC channel"));
      process.send({ kind, taskId, phase, pid: process.pid, ...(error ? { error } : {}) }, (failure) =>
        failure ? reject(failure) : done(),
      );
    });
  };
  try {
    const runtime = graphFixtureRuntime({
      taskId,
      scenario,
      phase,
      store,
      receipts,
      observe: async (operation, details = {}) => {
        await client
          .db(database)
          .collection("observations")
          .insertOne(
            { taskId, operation, pid: process.pid, at: Date.now(), ...details },
            { writeConcern: { w: "majority", j: true } },
          );
      },
      barrier: async () => {
        await notify("barrier");
        return new Promise<never>(() => {});
      },
    });
    await runtime.run({ tenantId: "tenant", taskId }, `worker-${process.pid}`);
    await notify("result");
  } catch (error) {
    await notify("error", error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    await Promise.all([store.close(), client.close()]);
    process.disconnect?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await workerMain();
