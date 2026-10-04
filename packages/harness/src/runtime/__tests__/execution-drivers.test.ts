import type { ModelProvider } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { type ExecutionDriver, HarnessRuntime, type HarnessRuntimeConfig, HarnessUnsupportedError } from "../driver.js";
import { HarnessEventGapError, InMemoryHarnessEventStore } from "../events.js";
import { createHarnessDefinition, exportHarnessManifest, loadHarnessManifest } from "../resolve.js";
import { HarnessResourcePool, InMemoryHarnessSessionStore } from "../session-bindings.js";

const identity = { tenantId: "tenant-a", userId: "actor" };
const start = { identity, sessionId: "session" };
const grants = { toolIds: [], modelRoles: ["main"] };
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const driver = (
  execute: ExecutionDriver["start"],
  controls: ExecutionDriver["capabilities"]["controls"] = [],
): ExecutionDriver => ({
  id: "fixture",
  version: 1,
  capabilities: { controls, durable: false, controlledExecution: true, policyCoverage: "local" },
  start: execute,
});
const runtime = (execute: ExecutionDriver["start"], config: Partial<HarnessRuntimeConfig> = {}) =>
  new HarnessRuntime({ driver: driver(execute), grants, ...config });
const provider = (): ModelProvider => ({
  providerId: "fixture",
  modelId: "fixture",
  generate: vi.fn(async () => ({
    message: { role: "assistant" as const, content: "answer" },
    finishReason: "stop" as const,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    raw: {},
  })),
  stream: async function* () {
    yield { type: "text", text: "answer" };
    yield { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  },
});

async function collect(handle: ReturnType<HarnessRuntime["start"]>) {
  const events = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

describe("H2 run handles", () => {
  it("settles once and reports identical terminal result, IDs and cursor", async () => {
    const handle = runtime(async () => ({ text: "ok" })).start("hello", {
      ...start,
      parentRunId: "parent",
      rootRunId: "root",
    });
    const events = await collect(handle);
    const result = await handle.result();
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.every((event) => event.parentRunId === "parent" && event.rootRunId === "root")).toBe(true);
    expect(events.at(-1)?.payload).toEqual({ type: "run.terminal", result });
    handle.cancel();
    expect(await handle.result()).toEqual(result);
  });
  it("cancel before start never enters driver and still settles a terminal event", async () => {
    const execute = vi.fn(async () => ({ text: "late" }));
    const handle = runtime(execute).start("hello", start);
    handle.cancel();
    expect((await handle.result()).status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
    expect((await collect(handle)).filter((event) => event.payload.type === "run.terminal")).toHaveLength(1);
  });
  it("holds lease and resources until cancelled work actually quiesces", async () => {
    const entered = deferred();
    const release = deferred();
    const dispose = vi.fn(async () => {});
    const rt = runtime(async (_request, services) => {
      await services.resource("owned", "run", async () => ({ value: {}, ownership: "runtime", dispose }));
      entered.resolve();
      await release.promise;
      return { text: "late" };
    });
    const handle = rt.start("hello", start);
    await entered.promise;
    handle.cancel();
    let settled = false;
    void handle.result().then(() => {
      settled = true;
    });
    const conflict = await rt.start("other", start).result();
    expect(conflict.reason?.code).toBe("session_conflict");
    expect(settled).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    release.resolve();
    expect((await handle.result()).status).toBe("cancelled");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await rt.start("next", start).result()).status).toBe("completed");
  });
  it("bounds event history and returning a pending viewer releases it without cancelling run", async () => {
    const store = new InMemoryHarnessEventStore({ sessionId: "s", runId: "r", attemptId: "a", rootRunId: "r" }, 2);
    const viewer = store.events();
    const pending = viewer.next();
    await viewer.return(undefined);
    expect((await pending).done).toBe(true);
    for (let index = 0; index < 3; index++) store.append({ type: "text.delta", text: "x" });
    await expect(store.events().next()).rejects.toBeInstanceOf(HarnessEventGapError);
    expect((await store.events({ after: 1 }).next()).value.sequence).toBe(2);
  });
  it("serializes concurrent viewer reads and closes every pending waiter", async () => {
    const store = new InMemoryHarnessEventStore({ sessionId: "s", runId: "r", attemptId: "a", rootRunId: "r" });
    const viewer = store.events();
    const first = viewer.next();
    const second = viewer.next();
    store.append({ type: "text.delta", text: "one" });
    store.append({ type: "text.delta", text: "two" });
    expect((await first).value.sequence).toBe(1);
    expect((await second).value.sequence).toBe(2);
    const third = viewer.next();
    const fourth = viewer.next();
    await viewer.return(undefined);
    expect((await third).done).toBe(true);
    expect((await fourth).done).toBe(true);
  });
  it("reports lease-release errors without losing the single terminal result", async () => {
    const rt = runtime(async () => ({ text: "ok" }), {
      sessionStore: {
        guarantees: { durable: false, compareAndSwap: false, singleWriter: "process" },
        acquire: async () => ({
          read: () => ({ history: [], state: {}, replayable: true, revision: 0 }),
          commit() {},
          release() {
            throw new Error("release failed");
          },
        }),
      },
    });
    const handle = rt.start("hello", start);
    const result = await handle.result();
    expect(result.cleanupDiagnostics).toEqual(["session_release_failed"]);
    expect((await collect(handle)).filter((event) => event.payload.type === "run.terminal")).toEqual([
      expect.objectContaining({ payload: { type: "run.terminal", result } }),
    ]);
  });
  it("rejects unsupported recovery/control claims before execution", async () => {
    const base = driver(async () => ({ text: "ok" }));
    expect(
      () => new HarnessRuntime({ grants, driver: { ...base, capabilities: { ...base.capabilities, durable: true } } }),
    ).toThrow(HarnessUnsupportedError);
    expect(
      () =>
        new HarnessRuntime({
          grants,
          driver: { ...base, capabilities: { ...base.capabilities, policyCoverage: "remote" } },
        }),
    ).toThrow(HarnessUnsupportedError);
    const gate = deferred();
    const handle = runtime(async () => {
      await gate.promise;
      return { text: "ok" };
    }).start("hello", start);
    await expect(handle.send("replacement", { mode: "replace" })).rejects.toBeInstanceOf(HarnessUnsupportedError);
    gate.resolve();
    await handle.result();
  });
  it("queues followups and steering explicitly at driver boundaries", async () => {
    const entered = deferred();
    const release = deferred();
    const seen: unknown[] = [];
    const rt = new HarnessRuntime({
      grants,
      driver: driver(
        async (request, services) => {
          seen.push(request.input);
          entered.resolve();
          await release.promise;
          seen.push(services.takeInput()?.input);
          return { text: String(request.input) };
        },
        ["follow_up", "steer"],
      ),
    });
    const handle = rt.start("first", start);
    await entered.promise;
    await handle.send("steer", { mode: "steer" });
    await handle.send("second", { mode: "follow_up" });
    release.resolve();
    expect((await handle.result()).text).toBe("second");
    expect(seen).toEqual(["first", "steer", "second", undefined]);
  });
});

describe("H2 policy/controller/context", () => {
  it("snapshots host budgets and rejects controller grant widening", async () => {
    const model = provider();
    const budgets = { maxModelCalls: 0 };
    const rt = runtime(
      async (_request, services) => {
        await services.model(model, []);
        return { text: "bad" };
      },
      { budgets },
    );
    budgets.maxModelCalls = 9;
    expect((await rt.start("hi", start).result()).status).toBe("stopped");
    expect(model.generate).not.toHaveBeenCalled();
    const denied = runtime(
      async (_request, services) => {
        await services.model(model, []);
        return { text: "bad" };
      },
      { controller: { id: "wide", prepareStep: async () => ({ activeToolIds: ["admin"] }) } },
    );
    expect((await denied.start("hi", start).result()).reason?.message).toMatch(/widen/);
  });
  it("clamps model output budget and reserves concurrent model call slots", async () => {
    const model = provider();
    const rt = runtime(
      async (_request, services) => {
        await services.model(model, [], { maxTokens: 999 });
        return { text: "ok" };
      },
      { budgets: { maxTokens: 10, maxModelCalls: 1 } },
    );
    expect((await rt.start("hi", start).result()).usage.totalTokens).toBe(2);
    expect(vi.mocked(model.generate).mock.calls[0][1]?.maxTokens).toBe(10);
    expect(vi.mocked(model.generate).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    const concurrent = runtime(
      async (_request, services) => {
        await Promise.all([services.model(model, []), services.model(model, [])]);
        return { text: "bad" };
      },
      { budgets: { maxModelCalls: 1 } },
    );
    expect((await concurrent.start("hi", start).result()).status).toBe("stopped");
  });
  it("required tools and provider options fail closed", async () => {
    const model = provider();
    const rt = runtime(
      async (_request, services) => {
        await services.model(model, []);
        return { text: "bad" };
      },
      { grants: { toolIds: ["required"], requiredToolIds: ["required"], modelRoles: ["main"] } },
    );
    expect((await rt.start("hi", start).result()).reason?.message).toMatch(/required tool/);
    const options = runtime(
      async (_request, services) => {
        await services.model(model, []);
        return { text: "bad" };
      },
      { controller: { id: "options", prepareStep: async () => ({ options: { temperature: 0 } }) } },
    );
    expect((await options.start("hi", start).result()).reason?.code).toBe("unsupported");
  });
  it("model role changes reject opaque continuation and preserve canonical history under projection", async () => {
    const model = provider();
    const sessions = new InMemoryHarnessSessionStore();
    const opaque = { role: "assistant" as const, content: "prior", providerExtras: { encrypted: "opaque" } };
    const switched = runtime(
      async (_request, services) => {
        await services.model(model, [opaque]);
        return { text: "bad" };
      },
      {
        grants: { toolIds: [], modelRoles: ["other"] },
        models: { other: { provider: model } },
        controller: { id: "switch", prepareStep: async () => ({ modelRole: "other" }) },
      },
    );
    expect((await switched.start("hi", start).result()).reason?.message).toMatch(/opaque/);
    const rt = runtime(
      async (_request, services) => {
        services.append([{ role: "user", content: "canonical" }]);
        await services.model(model, [...services.history]);
        return { text: "ok" };
      },
      {
        sessionStore: sessions,
        contextPolicy: { id: "project", project: async () => ({ messages: [], provenance: [] }) },
      },
    );
    await rt.start("hi", start).result();
    const lease = await sessions.acquire(identity, start.sessionId);
    expect(lease.read().history[0].content).toBe("canonical");
    lease.release();
  });
  it("mandatory policy blocks dispatch and completion revisions cannot replay effects", async () => {
    const execute = vi.fn(async () => "effect");
    const tool = { name: "effect", description: "effect", parameters: z.object({}), execute };
    const rt = runtime(
      async (_request, services) => {
        const result = await services.dispatch({ id: "call", name: "effect", arguments: {} });
        return { text: result.error ?? "ok" };
      },
      {
        tools: [tool],
        grants: { toolIds: ["effect"], modelRoles: [] },
        completionPolicy: {
          id: "review",
          evaluate: async ({ revision }) =>
            revision === 0
              ? { action: "revise", reason: "revise", instruction: "again" }
              : { action: "accept", reason: "done" },
        },
        budgets: { maxRevisions: 1 },
      },
    );
    expect((await rt.start("hi", start).result()).text).toMatch(/revisions/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("bounded revision, prepare-run stop and await-input report precise statuses", async () => {
    const revise = runtime(async () => ({ text: "draft" }), {
      completionPolicy: {
        id: "never",
        evaluate: async () => ({ action: "revise", instruction: "again", reason: "no" }),
      },
      budgets: { maxRevisions: 1 },
    });
    expect((await revise.start("hi", start).result()).reason?.code).toBe("revision_limit");
    const stopped = runtime(
      async () => {
        throw new Error("must not run");
      },
      { controller: { id: "stop", prepareRun: async () => ({ stop: { reason: "stop now" } }) } },
    );
    expect((await stopped.start("hi", start).result()).status).toBe("stopped");
    const awaiting = runtime(async () => ({ text: "question" }), {
      completionPolicy: { id: "question", evaluate: async () => ({ action: "await_input", reason: "need input" }) },
    });
    expect((await awaiting.start("hi", start).result()).status).toBe("awaiting_input");
  });
  it("applies bound prompts, source context and middleware to custom driver model calls", async () => {
    const model = provider();
    const observed = vi.fn();
    const definition = createHarnessDefinition({
      id: "context",
      abilities: [
        {
          instanceId: "context",
          validate() {},
          describe: () => ({ toolNames: [], requirements: [] }),
          bind: async () => ({
            tools: [],
            promptFragments: [{ id: "host", text: "host instructions" }],
            contextSources: [
              {
                id: "source",
                fetch: async () => [{ id: "entry", text: "untrusted data", trust: "source", byteLength: 14 }],
              },
            ],
            middleware: [
              {
                id: "observer",
                afterModel: async () => {
                  observed();
                },
              },
            ],
          }),
        },
      ],
    });
    const rt = runtime(
      async (_request, services) => {
        await services.model(model, [{ role: "user", content: "hello" }]);
        return { text: "ok" };
      },
      { definition },
    );
    expect((await rt.start("hello", start).result()).status).toBe("completed");
    expect(vi.mocked(model.generate).mock.calls[0][0][0].content).toBe("host instructions");
    expect(vi.mocked(model.generate).mock.calls[0][0][1].providerExtras?.harnessContext).toBeDefined();
    expect(observed).toHaveBeenCalledOnce();
  });
});

describe("H2 reviewed lifecycle boundaries", () => {
  it("preserves class prototype implementations and their private state", async () => {
    const model = provider();
    class Driver implements ExecutionDriver {
      id = "class";
      version = 1;
      capabilities = { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" as const };
      #calls = 0;
      async start(
        _request: Parameters<ExecutionDriver["start"]>[0],
        services: Parameters<ExecutionDriver["start"]>[1],
      ) {
        await services.model(model, []);
        return { text: String(++this.#calls) };
      }
    }
    class Controller {
      id = "controller";
      #count = 0;
      get count() {
        return this.#count;
      }
      async prepareStep() {
        this.#count++;
        return {};
      }
    }
    class Projection {
      id = "projection";
      #count = 0;
      get count() {
        return this.#count;
      }
      async project(input: { history: readonly import("@agentium/core").ChatMessage[] }) {
        this.#count++;
        return { messages: [...input.history], provenance: [] };
      }
    }
    class Completion {
      id = "completion";
      #count = 0;
      get count() {
        return this.#count;
      }
      async evaluate() {
        this.#count++;
        return { action: "accept" as const, reason: "accepted" };
      }
    }
    const control = new Controller();
    const project = new Projection();
    const complete = new Completion();
    const rt = new HarnessRuntime({
      driver: new Driver(),
      controller: control,
      contextPolicy: project,
      completionPolicy: complete,
      grants,
    });
    expect((await rt.start("one", start).result()).text).toBe("1");
    expect((await rt.start("two", start).result()).text).toBe("2");
    expect([control.count, project.count, complete.count]).toEqual([2, 2, 2]);
  });

  for (const streaming of [false, true]) {
    it(`cancellation during projection never starts a new provider call (stream=${streaming})`, async () => {
      const entered = deferred();
      const release = deferred();
      const model = provider();
      model.stream = vi.fn(model.stream);
      const rt = runtime(
        async (_request, services) => {
          if (streaming) {
            for await (const _chunk of services.streamModel(model, [])) {
            }
          } else await services.model(model, []);
          return { text: "bad" };
        },
        {
          contextPolicy: {
            id: "deferred",
            project: async ({ history }) => {
              entered.resolve();
              await release.promise;
              return { messages: [...history], provenance: [] };
            },
          },
        },
      );
      const handle = rt.start("hi", start);
      await entered.promise;
      handle.cancel();
      release.resolve();
      expect((await handle.result()).status).toBe("cancelled");
      expect(model.generate).not.toHaveBeenCalled();
      expect(model.stream).not.toHaveBeenCalled();
    });
    it(`late completed usage survives cancellation (stream=${streaming})`, async () => {
      const entered = deferred();
      const release = deferred();
      const model = provider();
      const original = model.generate;
      model.generate = async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      };
      model.stream = async function* () {
        entered.resolve();
        await release.promise;
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      };
      const rt = runtime(async (_request, services) => {
        if (streaming) {
          for await (const _chunk of services.streamModel(model, [])) {
          }
        } else await services.model(model, []);
        return { text: "bad" };
      });
      const handle = rt.start("hi", start);
      await entered.promise;
      handle.cancel();
      release.resolve();
      expect(await handle.result()).toMatchObject({ status: "cancelled", usage: { totalTokens: 2 } });
      expect((await collect(handle)).filter((event) => event.payload.type === "model.complete")).toHaveLength(0);
    });
  }
  it("waits for a detached stream before releasing owned resources or the session writer", async () => {
    const entered = deferred();
    const release = deferred();
    const dispose = vi.fn(async () => {});
    const model = provider();
    model.stream = async function* () {
      entered.resolve();
      await release.promise;
      yield { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    };
    const rt = runtime(async (_request, services) => {
      await services.resource("live", "run", async () => ({ value: {}, ownership: "runtime", dispose }));
      void services
        .streamModel(model, [])
        .next()
        .catch(() => {});
      await entered.promise;
      return { text: "premature" };
    });
    const handle = rt.start("hi", start);
    await entered.promise;
    expect((await rt.start("conflict", start).result()).reason?.code).toBe("session_conflict");
    expect(dispose).not.toHaveBeenCalled();
    release.resolve();
    expect((await handle.result()).status).toBe("failed");
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("streaming invokes bound afterModel with the reconstructed completed envelope", async () => {
    const observed = vi.fn();
    const model = provider();
    const definition = createHarnessDefinition({
      id: "stream-observer",
      abilities: [
        {
          instanceId: "observer",
          validate() {},
          describe: () => ({ toolNames: [], requirements: [] }),
          bind: async () => ({
            tools: [],
            middleware: [
              {
                id: "observe",
                afterModel: async (response) => {
                  observed(response);
                },
              },
            ],
          }),
        },
      ],
    });
    const rt = runtime(
      async (_request, services) => {
        for await (const _chunk of services.streamModel(model, [])) {
        }
        return { text: "ok" };
      },
      { definition },
    );
    expect((await rt.start("hi", start).result()).status).toBe("completed");
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0]).toMatchObject({
      message: { role: "assistant", content: "answer" },
      usage: { totalTokens: 2 },
    });
  });
  it.each([-100, NaN, Infinity, 0, 1.5])(
    "rejects invalid maxTokens %s before reservation or provider invocation",
    async (maxTokens) => {
      const model = provider();
      const rt = runtime(
        async (_request, services) => {
          await services.model(model, [], { maxTokens });
          return { text: "bad" };
        },
        { budgets: { maxTokens: 10 } },
      );
      expect((await rt.start("hi", start).result()).reason?.code).toBe("unsupported");
      expect(model.generate).not.toHaveBeenCalled();
      const safe = runtime(
        async (_request, services) => {
          await Promise.all([services.model(model, [], { maxTokens }), services.model(model, [], { maxTokens: 1000 })]);
          return { text: "bad" };
        },
        { budgets: { maxTokens: 10 } },
      );
      await safe.start("hi", start).result();
      for (const args of vi.mocked(model.generate).mock.calls) expect(args[1]?.maxTokens).toBeLessThanOrEqual(10);
    },
  );
});

describe("H2 sessions, resources and portable registry", () => {
  it("reuses scoped session resources, isolates tenants, reverses cleanup and never closes host clients", async () => {
    const pool = new HarnessResourcePool();
    const closed: string[] = [];
    const init = vi.fn(async () => ({
      value: {},
      ownership: "runtime" as const,
      dispose: async () => {
        closed.push("first");
      },
    }));
    const a = await pool.acquire(identity, "s", "first", "session", init);
    await a.release();
    const b = await pool.acquire(identity, "s", "first", "session", init);
    expect(a.value).toBe(b.value);
    await b.release();
    const second = await pool.acquire(identity, "s", "second", "session", async () => ({
      value: {},
      ownership: "runtime",
      dispose: async () => {
        closed.push("second");
      },
    }));
    await second.release();
    const other = await pool.acquire({ ...identity, tenantId: "tenant-b" }, "s", "first", "session", init);
    expect(other.value).not.toBe(a.value);
    await other.release();
    const host = vi.fn(async () => {});
    const external = await pool.acquire(identity, "s", "host", "host", async () => ({
      value: {},
      ownership: "host",
      dispose: host,
    }));
    await external.release();
    await pool.closeSession(identity, "s");
    expect(closed).toEqual(["second", "first"]);
    expect(host).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledTimes(2);
  });
  it("failed initialization disposes acquired run resources and preserves original error", async () => {
    const dispose = vi.fn(async () => {
      throw new Error("cleanup error");
    });
    const rt = runtime(async (_request, services) => {
      await services.resource("first", "run", async () => ({ value: {}, ownership: "runtime", dispose }));
      await services.resource("second", "run", async () => {
        throw new Error("initialization error");
      });
      return { text: "bad" };
    });
    expect((await rt.start("hi", start).result()).reason?.message).toBe("initialization error");
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("old sessions are explicitly non-replayable and artifact access is tenant scoped", async () => {
    const sessions = new InMemoryHarnessSessionStore();
    sessions.importLegacy(identity, "session", [{ role: "user", content: "old" }]);
    const lease = await sessions.acquire(identity, "session");
    expect(lease.read().replayable).toBe(false);
    lease.release();
    const rt = runtime(async (_request, services) => {
      const id = services.putArtifact("secret");
      return { text: "ok", artifacts: [{ id }] };
    });
    const result = await rt.start("hi", start).result();
    const id = result.artifacts![0].id;
    expect(rt.getArtifact(identity, "session", id)).toBe("secret");
    expect(rt.getArtifact({ ...identity, tenantId: "tenant-b" }, "session", id)).toBeUndefined();
  });
  it("portable references load from approved registry and local executables require exact export mappings", async () => {
    const executable = driver(async () => ({ text: "portable" }));
    const references = { driver: { id: "fixture", version: 1 } };
    const registry = { driver: [{ ...references.driver, implementation: executable }] };
    const definition = createHarnessDefinition({
      id: "portable",
      runtime: { driver: executable },
      runtimeReferences: references,
      runtimeRegistry: registry,
    });
    const manifest = exportHarnessManifest(definition);
    const loaded = loadHarnessManifest(manifest, [], registry);
    expect((await new HarnessRuntime({ definition: loaded, grants }).start("hi", start).result()).text).toBe(
      "portable",
    );
    expect(() => loadHarnessManifest(manifest, [])).toThrow(/runtime.driver/);
    expect(() =>
      exportHarnessManifest(createHarnessDefinition({ id: "local", runtime: { driver: executable } })),
    ).toThrow(/runtime.driver/);
  });
});
