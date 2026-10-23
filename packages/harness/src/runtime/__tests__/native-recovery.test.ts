import {
  type DurableJSON,
  defineTool,
  durableCanonical,
  type InputReply,
  type InputRequest,
  type ModelProvider,
  type ModelResponse,
} from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { agentDriver } from "../../drivers.js";
import { type ExecutionDriver, type HarnessBudgetState, HarnessRuntime, type RunHandle } from "../driver.js";
import {
  createHarnessNativeRecovery,
  HarnessNativeInputPending,
  type HarnessNativeJournal,
  isHarnessNativeInputPending,
  nativeJSON,
} from "../native-recovery.js";

const identity = { tenantId: "tenant", userId: "actor" };
const zero = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
async function messageEvents(handle: RunHandle) {
  const messages = [];
  for await (const event of handle.events()) {
    if (event.payload.type.startsWith("message.")) messages.push(event.payload);
  }
  return messages;
}
function response(text: string): ModelResponse {
  return {
    message: { role: "assistant", content: text },
    usage: zero,
    finishReason: "stop",
    raw: { secret: "excluded" },
  };
}
function journal() {
  const records = new Map<string, { input: DurableJSON; value: DurableJSON }>();
  let afterWrite: ((id: string, input: DurableJSON) => void) | undefined;
  const port: HarnessNativeJournal = {
    async operation(id, input, execute) {
      const prior = records.get(id);
      if (prior) {
        if (durableCanonical(input) !== durableCanonical(prior.input))
          throw new Error(`Journal identity mismatch: ${id}`);
        return structuredClone(prior.value);
      }
      const value = await execute();
      records.set(id, structuredClone({ input, value }));
      afterWrite?.(id, input);
      return structuredClone(value);
    },
  };
  return {
    port,
    records,
    failAfterWrite(callback: typeof afterWrite) {
      afterWrite = callback;
    },
  };
}

describe("native decision recovery", () => {
  it("recognizes validated pending errors across ESM and CommonJS class identities", () => {
    const equivalent = Object.assign(new Error("Awaiting user"), {
      code: "native_input_pending",
      request: { id: "question", runId: "run", question: "Continue?" },
    });
    expect(equivalent instanceof HarnessNativeInputPending).toBe(false);
    expect(isHarnessNativeInputPending(equivalent)).toBe(true);
    expect(
      isHarnessNativeInputPending(Object.assign(new Error("Invalid"), { code: "native_input_pending", request: {} })),
    ).toBe(false);
  });
  function fixture(
    store: ReturnType<typeof journal>,
    options: {
      stream?: boolean;
      answer?: (request: InputRequest) => Promise<InputReply>;
      initial?: string[];
      runMode?: "plan" | "execute";
    } = {},
  ) {
    let applied = options.initial ?? [];
    let projects = 0;
    let budget: HarnessBudgetState | undefined;
    const executeA = vi.fn(async () => {
      applied.push("a");
      return "A";
    });
    const executeB = vi.fn(async () => {
      applied.push("b");
      return "B";
    });
    const transformA = vi.fn(async () => "transformed A");
    const tools = [
      defineTool({
        name: "a",
        description: "First",
        parameters: z.object({}),
        execute: executeA,
        toModelOutput: transformA,
      }),
      defineTool({ name: "b", description: "Second", parameters: z.object({}), execute: executeB }),
      defineTool({
        name: "question",
        description: "Question",
        parameters: z.object({}),
        execute: async (_args, ctx) => {
          const reply = await ctx.executionServices?.requestInput?.({ question: "Continue?" });
          if (!reply) throw new Error("Missing input port");
          applied.push(String(reply.input));
          return String(reply.input);
        },
      }),
    ];
    const generate = vi.fn(async (messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") {
        expect(applied).toEqual(options.answer ? ["yes"] : ["a", "b"]);
        return response("done");
      }
      return {
        ...response(""),
        message: {
          role: "assistant",
          content: null,
          toolCalls: options.answer
            ? [{ id: "question-1", name: "question", arguments: {} }]
            : [
                { id: "call-a", name: "a", arguments: {} },
                { id: "call-b", name: "b", arguments: {} },
              ],
        },
        finishReason: "tool_calls",
      } satisfies ModelResponse;
    });
    const stream = vi.fn(async function* () {
      yield { type: "text", text: "hello " } as const;
      yield { type: "text", text: "world" } as const;
      yield { type: "finish", finishReason: "stop", usage: zero } as const;
    });
    const provider: ModelProvider = { providerId: "offline", modelId: "native", generate, stream };
    const prepareRun = vi.fn(async () => ({}));
    const prepareStep = vi.fn(async () => ({}));
    const afterTool = vi.fn(async () => {});
    const completion = vi.fn(async () => ({ action: "accept", reason: "Complete" }) as const);
    const runtime = new HarnessRuntime({
      driver: agentDriver({ name: "native", model: provider, tools, maxTokens: 16 }, { stream: options.stream }),
      grants: { modelRoles: ["main"], toolIds: ["a", "b", "question"] },
      budgets: { maxModelCalls: 4, maxToolCalls: 3, maxTokens: 1000 },
      controller: { id: "controller", prepareRun, prepareStep },
      contextPolicy: {
        id: "context",
        project: async ({ history }) => {
          projects++;
          return { messages: [...history], provenance: [] };
        },
      },
      completionPolicy: { id: "completion", evaluate: completion },
    });
    const start = (restoredBudget?: HarnessBudgetState, configuration: DurableJSON = { version: 1 }) =>
      runtime.start("original", {
        identity,
        sessionId: "session",
        runMode: options.runMode,
        recovery: {
          budgetState: restoredBudget,
          persistBudget: async (state) => {
            budget = state;
          },
          native: {
            taskId: "task",
            configuration,
            journal: store.port,
            application: {
              capture: () => ({ applied, projects }),
              restore: (state) => {
                const parsed = z.object({ applied: z.array(z.string()), projects: z.number() }).parse(state);
                applied = parsed.applied;
                projects = parsed.projects;
              },
            },
            requestInput: options.answer,
          },
        },
      });
    return {
      start,
      generate,
      stream,
      executeA,
      executeB,
      transformA,
      prepareRun,
      prepareStep,
      afterTool,
      completion,
      applied: () => applied,
      projects: () => projects,
      budget: () => budget,
    };
  }

  it("replays complete model, tool, controller and completion decisions in a fresh runtime", async () => {
    const store = journal();
    const first = fixture(store);
    expect((await first.start().result()).status).toBe("completed");
    expect(first.generate).toHaveBeenCalledTimes(2);
    expect(first.executeA).toHaveBeenCalledTimes(1);
    expect(first.transformA).toHaveBeenCalledTimes(1);
    const second = fixture(store, { initial: ["future must not leak"] });
    const result = await second.start(first.budget()).result();
    expect(result.status).toBe("completed");
    expect(result.text).toBe("done");
    expect(second.generate).not.toHaveBeenCalled();
    expect(second.executeA).not.toHaveBeenCalled();
    expect(second.transformA).not.toHaveBeenCalled();
    expect(second.executeB).not.toHaveBeenCalled();
    expect(second.prepareRun).not.toHaveBeenCalled();
    expect(second.prepareStep).not.toHaveBeenCalled();
    expect(second.completion).not.toHaveBeenCalled();
    expect(second.applied()).toEqual(["a", "b"]);
    expect(second.projects()).toBe(2);
    expect(result.budget?.modelCalls.used).toBe(2);
    expect(result.budget?.toolCalls.used).toBe(2);
    expect(JSON.stringify([...store.records])).not.toContain("excluded");
  });

  it("rejects run mode drift before restoring execute state into a plan run", async () => {
    const store = journal();
    const first = fixture(store);
    expect((await first.start().result()).status).toBe("completed");
    const second = fixture(store, { runMode: "plan", initial: ["plan state"] });
    const result = await second.start(first.budget()).result();
    expect(result.status).toBe("failed");
    expect(second.applied()).toEqual(["plan state"]);
    expect(second.generate).not.toHaveBeenCalled();
    expect(second.executeA).not.toHaveBeenCalled();
  });

  it("resumes between serialized batch members without repeating the settled member or provider", async () => {
    const store = journal();
    let crash = true;
    store.failAfterWrite((_id, input) => {
      if (crash && z.object({ kind: z.string(), input: z.unknown() }).parse(input).kind === "tool") {
        crash = false;
        throw new Error("Worker lease lost after durable write");
      }
    });
    const first = fixture(store);
    expect((await first.start().result()).status).toBe("failed");
    expect(first.executeA).toHaveBeenCalledTimes(1);
    expect(first.executeB).not.toHaveBeenCalled();
    const second = fixture(store);
    expect((await second.start(first.budget()).result()).status).toBe("completed");
    expect(second.executeA).not.toHaveBeenCalled();
    expect(second.executeB).toHaveBeenCalledTimes(1);
    expect(second.generate).toHaveBeenCalledTimes(1);
    expect(second.applied()).toEqual(["a", "b"]);
  });

  it("rejects configuration drift before invoking a provider or tool", async () => {
    const store = journal();
    const first = fixture(store);
    await first.start().result();
    const changed = fixture(store);
    const result = await changed.start(first.budget(), { version: 2 }).result();
    expect(result.status).toBe("failed");
    expect(result.reason?.message).toContain("identity mismatch");
    expect(changed.generate).not.toHaveBeenCalled();
    expect(changed.executeA).not.toHaveBeenCalled();
  });

  it("replays completed streams without reopening the provider stream", async () => {
    const store = journal();
    const first = fixture(store, { stream: true });
    const firstHandle = first.start();
    expect((await firstHandle.result()).text).toBe("hello world");
    const firstMessages = await messageEvents(firstHandle);
    const second = fixture(store, { stream: true });
    const secondHandle = second.start(first.budget());
    const result = await secondHandle.result();
    expect(result.status).toBe("completed");
    expect(result.text).toBe("hello world");
    expect(second.stream).not.toHaveBeenCalled();
    expect(second.generate).not.toHaveBeenCalled();
    expect(await messageEvents(secondHandle)).toEqual(firstMessages);
  });

  it("replays native control models and their decision outputs", async () => {
    const store = journal();
    let budget: HarnessBudgetState | undefined;
    const create = () => {
      const generate = vi.fn(async () => response("approved"));
      const provider: ModelProvider = {
        providerId: "offline",
        modelId: "critic",
        generate,
        async *stream() {
          yield { type: "finish", finishReason: "stop", usage: zero };
        },
      };
      const driver: ExecutionDriver = {
        id: "control-test",
        version: 1,
        capabilities: { controlledExecution: true, controls: [], policyCoverage: "local", durable: false },
        async start(_request, services) {
          const result = await services.controlModel("critic", [{ role: "user", content: "Check" }]);
          return { text: String(result.message.content) };
        },
      };
      const runtime = new HarnessRuntime({
        driver,
        models: { critic: { provider } },
        grants: { modelRoles: ["critic"], toolIds: [] },
      });
      return {
        generate,
        start: () =>
          runtime.start("test", {
            identity,
            sessionId: "control",
            recovery: {
              budgetState: budget,
              persistBudget: async (state) => {
                budget = state;
              },
              native: { taskId: "control", configuration: {}, journal: store.port },
            },
          }),
      };
    };
    const first = create();
    expect((await first.start().result()).text).toBe("approved");
    const second = create();
    expect((await second.start().result()).text).toBe("approved");
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(second.generate).not.toHaveBeenCalled();
  });

  it("suspends for durable input and accepts the same question in a replacement worker", async () => {
    const store = journal();
    const requests: InputRequest[] = [];
    let answered = false;
    const answer = async (request: InputRequest): Promise<InputReply> => {
      requests.push(request);
      if (!answered) throw new HarnessNativeInputPending(request);
      return { requestId: request.id, input: "yes" };
    };
    const first = fixture(store, { answer });
    const handle = first.start();
    expect((await handle.result()).status).toBe("awaiting_input");
    expect(handle.pendingInput?.id).toBe(requests[0]?.id);
    expect(handle.state).toBe("awaiting_input");
    answered = true;
    const second = fixture(store, { answer });
    const result = await second.start(first.budget()).result();
    expect(result.status).toBe("completed");
    expect(requests[1]?.id).toBe(requests[0]?.id);
    expect(second.generate).toHaveBeenCalledTimes(1);
    expect(second.applied()).toEqual(["yes"]);
  });

  it("replays a committed answer after losing the worker before the tool settles", async () => {
    const store = journal();
    const answer = vi.fn(
      async (request: InputRequest): Promise<InputReply> => ({ requestId: request.id, input: "yes" }),
    );
    let interrupted = false;
    store.failAfterWrite((_id, input) => {
      if (!interrupted && z.object({ kind: z.string() }).parse(input).kind === "input") {
        interrupted = true;
        throw new Error("Worker stopped after answer commit");
      }
    });
    const first = fixture(store, { answer });
    expect((await first.start().result()).reason?.code).toBe("native_recovery_failed");
    const second = fixture(store, { answer });
    expect((await second.start(first.budget()).result()).status).toBe("completed");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(second.applied()).toEqual(["yes"]);
  });

  it("reconstructs nested control usage once after a child commit loses its worker", async () => {
    const store = journal();
    let savedBudget: HarnessBudgetState | undefined;
    let lost = false;
    store.failAfterWrite((_id, input) => {
      if (!lost && z.object({ kind: z.string() }).parse(input).kind === "control") {
        lost = true;
        throw new Error("Lost after control commit");
      }
    });
    const create = () => {
      let inProjection = false;
      const critic = vi.fn(async () => response("summary"));
      const main = vi.fn(async () => response("done"));
      const provider = (modelId: string, generate: ModelProvider["generate"]): ModelProvider => ({
        providerId: "offline",
        modelId,
        generate,
        async *stream() {
          yield { type: "finish", finishReason: "stop", usage: zero };
        },
      });
      let summarize = async () => {};
      const runtime = new HarnessRuntime({
        driver: {
          id: "nested-usage",
          version: 1,
          capabilities: { controlledExecution: true, controls: [], policyCoverage: "local", durable: false },
          async start(_request, services) {
            summarize = async () => {
              await services.controlModel("critic", [{ role: "user", content: "Summarize" }]);
            };
            const result = await services.model(provider("main", main), [{ role: "user", content: "Request" }], {
              maxTokens: 16,
            });
            return { text: String(result.message.content) };
          },
        },
        models: { critic: { provider: provider("critic", critic) } },
        grants: { modelRoles: ["main", "critic"], toolIds: [] },
        budgets: { maxModelCalls: 4, maxTokens: 1000 },
        contextPolicy: {
          id: "summary",
          async project({ history }) {
            inProjection = true;
            try {
              await summarize();
              return { messages: [...history], provenance: [] };
            } finally {
              inProjection = false;
            }
          },
        },
      });
      return {
        critic,
        main,
        start: () =>
          runtime.start("request", {
            identity,
            sessionId: "nested-usage",
            recovery: {
              budgetState: savedBudget,
              persistBudget: async (state) => {
                savedBudget = state;
              },
              native: {
                taskId: "nested-usage",
                configuration: {},
                journal: store.port,
                application: {
                  capture: () => {
                    if (inProjection) throw new Error("Projection in flight");
                    return null;
                  },
                  restore: () => {},
                },
              },
            },
          }),
      };
    };
    const first = create();
    expect((await first.start().result()).status).toBe("failed");
    const second = create();
    const result = await second.start().result();
    expect(result.status).toBe("completed");
    expect(first.critic).toHaveBeenCalledTimes(1);
    expect(second.critic).not.toHaveBeenCalled();
    expect(second.main).toHaveBeenCalledTimes(1);
    expect(result.usage.totalTokens).toBe(4);
    expect(result.budget?.modelCalls.used).toBe(2);
    expect(result.budget?.tokens.used).toBe(4);
  });

  it.each(["input", "control-model"])(
    "records nested %s without snapshotting the surrounding in-flight state",
    async (kind) => {
      const store = journal();
      let lost = false;
      let inFlight = false;
      store.failAfterWrite((_id, input) => {
        if (!lost && z.object({ kind: z.string() }).parse(input).kind === kind) {
          lost = true;
          throw new Error("Lost after acceptance");
        }
      });
      const create = () =>
        createHarnessNativeRecovery(
          {
            taskId: "transient",
            configuration: {},
            journal: store.port,
            application: {
              capture: () => {
                if (inFlight) throw new Error("Cannot capture in-flight flags");
                return {};
              },
              restore: () => {
                if (inFlight) throw new Error("Cannot replace in-flight state");
              },
            },
          },
          {},
          {
            capture: () => {
              if (inFlight) throw new Error("Cannot capture SDK state during projection");
              return null;
            },
            restore: () => {
              if (inFlight) throw new Error("Cannot replace SDK state during projection");
            },
          },
        );
      const execute = (runtime: ReturnType<typeof create>) =>
        runtime.run(
          "tool",
          {},
          async () => {
            inFlight = true;
            try {
              return await runtime.run(kind, {}, async () => "accepted", nativeJSON);
            } finally {
              inFlight = false;
            }
          },
          nativeJSON,
        );
      const first = create();
      await first.initialize();
      await expect(execute(first)).rejects.toThrow("Lost after acceptance");
      const second = create();
      await second.initialize();
      expect(await execute(second)).toBe("accepted");
    },
  );

  it("preserves JSON property names and immutable retained values through the wire envelope", async () => {
    const store = journal();
    const value: unknown = JSON.parse('{"__proto__":{"table":"safe"},"constructor":4,"prototype":null}');
    const state = nativeJSON(value);
    const writes: DurableJSON[] = [];
    const create = () =>
      createHarnessNativeRecovery(
        {
          taskId: "key-test",
          configuration: state,
          journal: store.port,
          application: {
            capture: () => state,
            restore: (saved) => {
              writes.push(saved);
            },
          },
        },
        {},
        { capture: () => state, restore: () => {} },
      );
    const first = create();
    await first.initialize();
    expect(await first.run("keys", state, async () => state, nativeJSON)).toEqual(state);
    const second = create();
    await second.initialize();
    expect(
      await second.run(
        "keys",
        state,
        async () => {
          throw new Error("Must replay");
        },
        nativeJSON,
      ),
    ).toEqual(state);
    expect(writes).toHaveLength(4);
    const restored = writes[3];
    if (restored === null || typeof restored !== "object") throw new Error("Missing restored object");
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("table");
  });

  it("serializes sibling decisions and awaits persistence before the next decision", async () => {
    const store = journal();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: HarnessNativeJournal = {
      operation: async (id, input, execute) => {
        const result = await store.port.operation(id, input, execute);
        if (id.endsWith("0-first")) await gate;
        return result;
      },
    };
    const order: string[] = [];
    const recovery = createHarnessNativeRecovery(
      { taskId: "serial", configuration: {}, journal: port },
      {},
      {
        capture: () => order,
        restore: () => {},
      },
    );
    await recovery.initialize();
    const first = recovery.run(
      "first",
      {},
      async () => {
        order.push("first");
        return null;
      },
      () => undefined,
    );
    const next = recovery.run(
      "next",
      {},
      async () => {
        order.push("next");
        return null;
      },
      () => undefined,
    );
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    release?.();
    await Promise.all([first, next]);
    expect(order).toEqual(["first", "next"]);
  });

  it("retains 150 growing 64 KB results below the unchanged task cap and restores every checkpoint", async () => {
    const store = journal();
    const pages = Array.from({ length: 150 }, (_, page) => {
      const data = Buffer.alloc(65_536);
      let state = page + 1;
      for (let index = 0; index < data.length; index++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data[index] = 65 + ((state >>> 24) % 26);
      }
      return data.toString("ascii");
    });
    const create = () => {
      let history: string[] = [];
      let counter = 0;
      const execute = vi.fn(async (page: string) => {
        history.push(page);
        counter++;
        return page;
      });
      const recovery = createHarnessNativeRecovery(
        {
          taskId: "large-history",
          configuration: {},
          journal: store.port,
          application: {
            capture: () => ({ counter, history }),
            restore: (value) => {
              const state = z.object({ counter: z.number(), history: z.array(z.string()) }).parse(value);
              counter = state.counter;
              history = state.history;
            },
          },
        },
        {},
        {
          capture: () => ({ messages: history.map((content) => ({ role: "tool", content })), step: counter }),
          restore: (value) => {
            const state = z
              .object({
                messages: z.array(z.object({ role: z.literal("tool"), content: z.string() })),
                step: z.number(),
              })
              .parse(value);
            expect(state.messages).toHaveLength(state.step);
          },
        },
      );
      return { recovery, execute, state: () => ({ counter, history }) };
    };
    const first = create();
    await first.recovery.initialize();
    for (const [index, page] of pages.entries()) {
      expect(await first.recovery.run("model", { messages: first.state().history }, async () => page, nativeJSON)).toBe(
        page,
      );
      expect(await first.recovery.run("tool", { index }, () => first.execute(page), nativeJSON)).toBe(page);
    }
    const storedBytes = [...store.records.entries()].reduce((total, [id, record]) => {
      const bytes = Buffer.byteLength(durableCanonical(nativeJSON({ id, ...record })));
      expect(bytes).toBeLessThan(4_000_000);
      return total + bytes;
    }, 0);
    expect(storedBytes).toBeLessThan(128_000_000);
    expect(store.records.size).toBeLessThan(10_000);
    // The two full histories total almost 20 MB by the final decision; storing
    // each of 150 copies would exceed a gigabyte without fragment reuse.
    expect(storedBytes).toBeLessThan(45_000_000);
    const beforeReplay = store.records.size;
    const second = create();
    await second.recovery.initialize();
    for (const [index, page] of pages.entries()) {
      expect(
        await second.recovery.run(
          "model",
          { messages: second.state().history },
          async () => {
            throw new Error("Must replay model");
          },
          nativeJSON,
        ),
      ).toBe(page);
      expect(await second.recovery.run("tool", { index }, () => second.execute(page), nativeJSON)).toBe(page);
      expect(second.state().counter).toBe(index + 1);
      expect(second.state().history.at(-1)).toBe(page);
    }
    expect(second.execute).not.toHaveBeenCalled();
    expect(store.records.size).toBe(beforeReplay);
    expect(second.state()).toEqual(first.state());
  }, 300_000);

  it.each(["missing", "corrupt"])(
    "rejects a %s snapshot fragment before restoring application state",
    async (failure) => {
      const store = journal();
      const restore = vi.fn();
      const create = () =>
        createHarnessNativeRecovery(
          {
            taskId: "fragments",
            configuration: {},
            journal: store.port,
            application: { capture: () => ({ text: "value".repeat(5000) }), restore },
          },
          {},
          { capture: () => null, restore: () => {} },
        );
      await create().initialize();
      restore.mockClear();
      const fragment = [...store.records.entries()].find(([id]) => id.startsWith("native/snapshot/"));
      if (!fragment) throw new Error("Expected retained snapshot fragment");
      if (failure === "missing") store.records.delete(fragment[0]);
      else fragment[1].value = { version: 1, data: "changed" };
      await expect(create().initialize()).rejects.toThrow(
        failure === "missing" ? "Missing retained" : "Invalid retained",
      );
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it("commits snapshot fragments before their referring checkpoint and retries a lost fragment write", async () => {
    const store = journal();
    let lost = false;
    store.failAfterWrite((id) => {
      if (!lost && id.startsWith("native/snapshot/")) {
        lost = true;
        throw new Error("Lost after fragment write");
      }
    });
    const restore = vi.fn();
    const create = () =>
      createHarnessNativeRecovery(
        {
          taskId: "fragment-order",
          configuration: {},
          journal: store.port,
          application: { capture: () => ({ text: "😀漢字".repeat(5000) }), restore },
        },
        {},
        { capture: () => null, restore: () => {} },
      );
    await expect(create().initialize()).rejects.toThrow("Lost after fragment write");
    expect(store.records.has("native/initial")).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    await create().initialize();
    expect(store.records.has("native/initial")).toBe(true);
    expect(restore).toHaveBeenCalledWith({ text: "😀漢字".repeat(5000) });
    expect([...store.records.keys()].at(-1)).toBe("native/initial");
    for (const [id, record] of store.records) {
      if (!id.startsWith("native/snapshot/")) continue;
      const { data } = z.object({ data: z.string() }).parse(record.value);
      expect(data).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
  });

  it("fails closed on oversized records and never enters a later sibling", async () => {
    const store = journal();
    const recovery = createHarnessNativeRecovery(
      { taskId: "limit", configuration: {}, journal: store.port, maxRecordBytes: 500 },
      {},
      {
        capture: () => null,
        restore: () => {},
      },
    );
    await recovery.initialize();
    const next = vi.fn(async () => null);
    const first = recovery.run("large", {}, async () => "x".repeat(1000), nativeJSON);
    const following = recovery.run("blocked", {}, next, nativeJSON);
    await expect(first).rejects.toThrow("byte limit");
    await expect(following).rejects.toThrow("byte limit");
    expect(next).not.toHaveBeenCalled();
    expect(store.records.has("native/0-large")).toBe(false);
    expect(store.records.has("native/1-blocked")).toBe(false);
  });
});
