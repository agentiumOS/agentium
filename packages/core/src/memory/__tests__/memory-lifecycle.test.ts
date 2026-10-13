import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse } from "../../models/types.js";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { MemoryManager } from "../memory-manager.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function summaryModel(promise: Promise<ModelResponse>): ModelProvider {
  return { providerId: "fixture", modelId: "fixture-summary", generate: () => promise, async *stream() {} };
}

async function launchSummary(memory: MemoryManager, sessionId = "s") {
  await memory.appendMessages(sessionId, [
    { role: "user", content: "old turn" },
    { role: "assistant", content: "old reply" },
  ]);
  return memory.appendMessages(sessionId, [
    { role: "user", content: "new turn" },
    { role: "assistant", content: "new reply" },
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MemoryManager background lifecycle", () => {
  it("includes constructor-launched storage initialization", async () => {
    const initialization = deferred<void>();
    const storage = Object.assign(new InMemoryStorage(), { initialize: () => initialization.promise });
    const memory = new MemoryManager({ storage, summaries: false });
    expect(await memory.drain({ timeoutMs: 0 })).toEqual({ status: "timed_out", pending: 1, failed: 0 });
    initialization.resolve();
    expect(await memory.drain()).toEqual({ status: "drained", pending: 0, failed: 0 });
  });

  it("handles pre-aborted waits without cancelling owned operations or allocating a timer", async () => {
    vi.useFakeTimers();
    const initialization = deferred<void>();
    const storage = Object.assign(new InMemoryStorage(), { initialize: () => initialization.promise });
    const memory = new MemoryManager({ storage, summaries: false });
    const controller = new AbortController();
    controller.abort();
    expect(await memory.drain({ signal: controller.signal, timeoutMs: 100 })).toEqual({
      status: "cancelled",
      pending: 1,
      failed: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    initialization.resolve();
    await memory.drain();
    expect(await memory.drain({ signal: controller.signal })).toEqual({ status: "drained", pending: 0, failed: 0 });
  });

  it("does not wrap a long timeout into an immediate deadline", async () => {
    vi.useFakeTimers();
    const initialization = deferred<void>();
    const storage = Object.assign(new InMemoryStorage(), { initialize: () => initialization.promise });
    const memory = new MemoryManager({ storage, summaries: false });
    let settled = false;
    const waiting = memory.drain({ timeoutMs: 2_147_483_648 }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    initialization.resolve();
    expect((await waiting).status).toBe("drained");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaitExtractions waits for overflow summary generation and its final storage write", async () => {
    const response = deferred<ModelResponse>();
    const storage = new InMemoryStorage();
    const memory = new MemoryManager({ storage, maxMessages: 2, model: summaryModel(response.promise) });
    expect((await launchSummary(memory)).overflow).toHaveLength(2);
    let settled = false;
    const waiting = memory.awaitExtractions().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    response.resolve({
      message: { role: "assistant", content: "old conversation summary" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      raw: {},
    });
    await waiting;
    expect(await memory.getSummaries()?.getSummaries("s")).toEqual(["old conversation summary"]);
  });

  it("timeout leaves summary work tracked and a later drain observes the final write", async () => {
    vi.useFakeTimers();
    const response = deferred<ModelResponse>();
    const memory = new MemoryManager({
      storage: new InMemoryStorage(),
      maxMessages: 2,
      model: summaryModel(response.promise),
    });
    await launchSummary(memory);
    const waiting = memory.drain({ timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting).toEqual({ status: "timed_out", pending: 1, failed: 0 });
    expect(vi.getTimerCount()).toBe(0);
    response.resolve({
      message: { role: "assistant", content: "persisted later" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      raw: {},
    });
    expect(await memory.drain()).toEqual({ status: "drained", pending: 0, failed: 0 });
    expect(await memory.getSummaries()?.getSummaries("s")).toEqual(["persisted later"]);
  });

  it("includes extractions added while another operation is still pending", async () => {
    const memory = new MemoryManager({ storage: new InMemoryStorage(), summaries: false, userFacts: true });
    const facts = memory.getUserFacts();
    if (!facts) throw new Error("missing fixture user facts");
    const first = deferred<void>();
    const second = deferred<void>();
    vi.spyOn(facts, "extractAndStore")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    void memory.afterRun("s", "u", []);
    let settled = false;
    const waiting = memory.drain().then((result) => {
      settled = true;
      return result;
    });
    void memory.afterRun("s", "u", []);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    expect(await waiting).toEqual({ status: "drained", pending: 0, failed: 0 });
  });

  it("counts each failed store operation once and emits one diagnostic per operation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: Array<{ store: string }> = [];
    const eventBus = new EventBus();
    eventBus.on("memory.error", (event) => {
      events.push(event);
    });
    const storage = new InMemoryStorage();
    const summaryWrite = deferred<void>();
    const set = storage.set.bind(storage);
    vi.spyOn(storage, "set").mockImplementation((namespace, key, value) =>
      namespace === "memory:summaries" ? summaryWrite.promise : set(namespace, key, value),
    );
    const memory = new MemoryManager({ storage, maxMessages: 2, userFacts: true, userProfile: true, eventBus });
    const facts = memory.getUserFacts();
    const profile = memory.getUserProfile();
    if (!facts || !profile) throw new Error("missing fixture stores");
    const factsWork = deferred<void>();
    const profileWork = deferred<void>();
    vi.spyOn(facts, "extractAndStore").mockImplementation(() => factsWork.promise);
    vi.spyOn(profile, "extractAndUpdate").mockImplementation(() => profileWork.promise);
    await launchSummary(memory);
    const extraction = memory.afterRun("s", "u", []);
    const drainOne = memory.drain();
    const drainTwo = memory.drain();
    factsWork.reject(new Error("facts storage failed"));
    profileWork.reject(new Error("profile storage failed"));
    summaryWrite.reject(new Error("summary storage failed"));
    expect(await drainOne).toEqual({ status: "drained", pending: 0, failed: 3 });
    expect(await drainTwo).toEqual({ status: "drained", pending: 0, failed: 3 });
    await expect(extraction).resolves.toBeUndefined();
    expect(events.map((event) => event.store).sort()).toEqual(["summaries", "userFacts", "userProfile"]);
    expect(await memory.drain()).toEqual({ status: "drained", pending: 0, failed: 0 });
  });

  it("cancellation stops only waiting and removes its abort listener and timeout", async () => {
    vi.useFakeTimers();
    const memory = new MemoryManager({ storage: new InMemoryStorage(), summaries: false, userFacts: true });
    const facts = memory.getUserFacts();
    if (!facts) throw new Error("missing fixture user facts");
    const work = deferred<void>();
    vi.spyOn(facts, "extractAndStore").mockImplementation(() => work.promise);
    void memory.afterRun("s", "u", []);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = memory.drain({ timeoutMs: 100, signal: controller.signal });
    controller.abort();
    expect(await waiting).toEqual({ status: "cancelled", pending: 1, failed: 0 });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    work.resolve();
    expect(await memory.drain()).toEqual({ status: "drained", pending: 0, failed: 0 });
  });

  it("successful and timed-out drains clean up deadline and abort listeners", async () => {
    vi.useFakeTimers();
    const memory = new MemoryManager({ storage: new InMemoryStorage(), summaries: false, userFacts: true });
    const facts = memory.getUserFacts();
    if (!facts) throw new Error("missing fixture user facts");
    const first = deferred<void>();
    const second = deferred<void>();
    vi.spyOn(facts, "extractAndStore")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    void memory.afterRun("s", "u", []);
    const success = memory.drain({ timeoutMs: 100, signal: controller.signal });
    first.resolve();
    expect((await success).status).toBe("drained");
    expect(vi.getTimerCount()).toBe(0);
    void memory.afterRun("s", "u", []);
    const timeout = memory.drain({ timeoutMs: 10, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    expect((await timeout).status).toBe("timed_out");
    expect(removed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    second.resolve();
    await memory.drain();
  });
});
