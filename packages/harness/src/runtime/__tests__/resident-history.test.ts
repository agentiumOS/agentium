import { Agent, type ChatMessage, type ModelProvider } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { agentDriver } from "../../drivers.js";
import { type ExecutionDriver, HarnessRuntime, type HarnessRuntimeConfig } from "../driver.js";
import type { HistoryArchive, ResidentHistoryPolicy } from "../history.js";
import { InMemoryHarnessSessionStore } from "../session-bindings.js";

const start = { identity: { tenantId: "t", userId: "u" }, sessionId: "s" };
const old: ChatMessage[] = [
  { role: "user", content: "old" },
  {
    role: "assistant",
    content: null,
    toolCalls: [{ id: "x", name: "tool", arguments: {} }],
    providerExtras: {
      anthropicContent: [
        { type: "thinking", thinking: "opaque", signature: "signed" },
        { type: "tool_use", id: "x", name: "tool", input: {} },
      ],
    },
  },
  { role: "tool", content: "result", toolCallId: "x" },
  { role: "assistant", content: "finished" },
];
const recent: ChatMessage[] = [
  { role: "user", content: "recent" },
  { role: "assistant", content: "recent answer" },
];
const provider = (): ModelProvider => ({
  providerId: "fixture",
  modelId: "fixture",
  generate: vi.fn<ModelProvider["generate"]>(async () => ({
    message: { role: "assistant", content: "answer" },
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    raw: {},
  })),
  async *stream() {},
});
function archive() {
  const data = new Map<string, readonly ChatMessage[]>();
  const store: HistoryArchive = {
    write: vi.fn(async (_, reference, messages) => {
      data.set(reference.id, structuredClone(messages));
    }),
    read: vi.fn(async (_, reference) => data.get(reference.id) ?? []),
  };
  return { store, data };
}
async function setup(
  execute: ExecutionDriver["start"],
  history: ChatMessage[],
  policy: ResidentHistoryPolicy,
  config: Partial<HarnessRuntimeConfig> = {},
) {
  const sessions = new InMemoryHarnessSessionStore();
  const lease = await sessions.acquire(start.identity, start.sessionId);
  lease.commit({ history, state: {}, replayable: true });
  lease.release();
  const runtime = new HarnessRuntime({
    sessionStore: sessions,
    residentHistory: policy,
    grants: { toolIds: [], modelRoles: ["main"] },
    driver: {
      id: "history",
      version: 1,
      capabilities: { controls: [], controlledExecution: true, durable: false, policyCoverage: "local" },
      start: execute,
    },
    ...config,
  });
  return { runtime, sessions };
}
describe("resident canonical history", () => {
  it("archives a complete signed tool exchange before eviction, retrieves by scoped reference and rejects corruption", async () => {
    const storage = archive();
    const model = provider();
    const { runtime, sessions } = await setup(
      async (_, services) => {
        await services.model(model, [...services.history]);
        expect(services.history).toEqual(recent);
        expect(await services.retrieveHistory(services.archivedHistory[0].id)).toEqual(old);
        return { text: "done" };
      },
      [...old, ...recent],
      { maxMessages: 2, archive: storage.store },
    );
    expect((await runtime.run("go", start)).status).toBe("completed");
    const lease = await sessions.acquire(start.identity, start.sessionId);
    const snapshot = lease.read();
    lease.release();
    expect(snapshot.history).toEqual(recent);
    expect(snapshot.conversations).toEqual({});
    const reference = snapshot.archivedHistory?.[0];
    expect(reference).toBeDefined();
    if (!reference) throw new Error("missing reference");
    expect(await runtime.retrieveHistory(start.identity, start.sessionId, reference.id)).toEqual(old);
    await expect(
      runtime.retrieveHistory({ ...start.identity, userId: "other" }, start.sessionId, reference.id),
    ).rejects.toThrow("Unknown scoped");
    storage.data.set(reference.id, []);
    await expect(runtime.retrieveHistory(start.identity, start.sessionId, reference.id)).rejects.toThrow(
      "canonical reference",
    );
  });
  it("does not evict on archive failure", async () => {
    const storage = archive();
    storage.store.write = vi.fn(async () => {
      throw new Error("archive unavailable");
    });
    const model = provider();
    const { runtime, sessions } = await setup(
      async (_, services) => {
        await services.model(model, [...services.history]);
        return { text: "done" };
      },
      [...old, ...recent],
      { maxMessages: 2, archive: storage.store },
    );
    expect((await runtime.run("go", start)).reason?.message).toBe("archive unavailable");
    expect(model.generate).not.toHaveBeenCalled();
    const lease = await sessions.acquire(start.identity, start.sessionId);
    expect(lease.read().history).toEqual([...old, ...recent]);
    lease.release();
  });
  it.each(["unknown", "unsupported", "oversized"])("rejects %s continuation/retention policies", async (kind) => {
    const storage = archive();
    const model = provider();
    if (kind === "unsupported") Object.assign(model, { capabilities: { historyEviction: "unsupported" } });
    const history =
      kind === "unknown"
        ? [
            ...old.map((message) =>
              message.providerExtras ? { ...message, providerExtras: { customOpaque: true } } : message,
            ),
            ...recent,
          ]
        : [...old, ...recent];
    const { runtime } = await setup(
      async (_, services) => {
        await services.model(model, [...services.history]);
        return { text: "done" };
      },
      history,
      { maxMessages: kind === "oversized" ? 1 : 2, archive: storage.store },
      { models: { main: { provider: model } } },
    );
    expect((await runtime.run("go", start)).reason?.code).toBe("history_retention_unsupported");
    expect(model.generate).not.toHaveBeenCalled();
    expect(storage.store.write).not.toHaveBeenCalled();
  });
  it("bounds the built-in Agent replay window and its session records while preserving full archived records", async () => {
    const storage = archive();
    const model = provider();
    const agent = new Agent({ name: "resident", model });
    const { runtime, sessions } = await setup(
      async () => ({ text: "unused" }),
      [...old, ...recent],
      { maxMessages: 4, archive: storage.store },
      { driver: agentDriver(agent) },
    );
    try {
      const result = await runtime.run("new", start);
      expect(result.status).toBe("completed");
      const sent = vi.mocked(model.generate).mock.calls[0][0];
      expect(sent.some((message) => message.content === "old")).toBe(false);
      const lease = await sessions.acquire(start.identity, start.sessionId);
      const snapshot = lease.read();
      lease.release();
      expect(snapshot.history.length).toBeLessThanOrEqual(4);
      expect(snapshot.archivedHistory?.length).toBeGreaterThan(0);
      expect(Object.keys(snapshot.conversations ?? {})).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });
});

it("keeps every signed call/result in the retained turn and archives completed child payloads", async () => {
  const storage = archive();
  const model = provider();
  const { runtime, sessions } = await setup(
    async (_, services) => {
      await services.model(model, [...services.history]);
      expect(services.history).toEqual(old);
      services.recordConversation("child", [
        { role: "user", content: "child" },
        { role: "assistant", content: "child result", providerExtras: { privateChildData: true } },
      ]);
      return { text: "done" };
    },
    [...recent, ...old],
    { maxMessages: 4, archive: storage.store },
  );
  expect((await runtime.run("go", start)).status).toBe("completed");
  expect(vi.mocked(model.generate).mock.calls[0][0]).toEqual(old);
  const lease = await sessions.acquire(start.identity, start.sessionId);
  const snapshot = lease.read();
  lease.release();
  expect(snapshot.conversations).toEqual({});
  const child = snapshot.archivedHistory?.find((reference) => reference.conversationId === "child");
  expect(child).toBeDefined();
  if (child)
    expect((await runtime.retrieveHistory(start.identity, start.sessionId, child.id))[1].providerExtras).toEqual({
      privateChildData: true,
    });
});
