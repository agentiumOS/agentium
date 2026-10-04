import { describe, expect, it } from "vitest";
import {
  type DurableBlobStore,
  DurableEventGapError,
  DurableRunRecords,
  JournaledDurableTaskStore,
} from "../records.js";
import { InMemoryDurableTaskStore } from "../store.js";

const key = { tenantId: "tenant", taskId: "task" };
const reader = { tenantId: "tenant", actorId: "actor" };
const fence = { workerId: "worker", fence: 1 };
async function fixture(maxEvents = 3) {
  let now = 1000;
  const inner = new InMemoryDurableTaskStore({ now: () => now });
  const store = new JournaledDurableTaskStore(inner, maxEvents);
  const objects = new Map<string, Uint8Array>();
  const blobs: DurableBlobStore = {
    durable: false,
    async put(id, bytes) {
      if (objects.has(id) && Buffer.compare(Buffer.from(objects.get(id)!), Buffer.from(bytes)))
        throw new Error("collision");
      objects.set(id, Uint8Array.from(bytes));
    },
    async get(id) {
      return objects.get(id) ?? null;
    },
    async delete(id) {
      objects.delete(id);
    },
  };
  const records = new DurableRunRecords(store, blobs, { maxEvents, maxArtifactBytes: 1000, now: () => now });
  await store.create({
    id: key.taskId,
    identity: { ...reader, sessionId: "session", runId: "run", rootRunId: "run" },
    manifestHash: "sha256:fixture",
    inputRef: "input",
    policyRevision: 1,
    grantRefs: ["grant"],
  });
  await store.update(key, (task) => {
    task.state = "running";
    task.fence = 1;
    task.lease = { ...fence, expiresAt: 100_000 };
    task.attempts.push({ id: "attempt", ...fence, startedAt: now });
  });
  return {
    store,
    records,
    blobs,
    objects,
    advance: (next: number) => {
      now = next;
    },
  };
}
describe("durable run records", () => {
  it("sequences concurrent writes with lifecycle state atomically, preserves gaps and reader ownership", async () => {
    const { store, records } = await fixture();
    await Promise.all([1, 2, 3].map((number) => records.append(key, fence, "text.delta", { number })));
    await expect(records.events(key, reader)).rejects.toBeInstanceOf(DurableEventGapError);
    expect((await records.events(key, reader, 1)).map((event) => event.sequence)).toEqual([2, 3, 4]);
    await expect(records.events(key, { ...reader, actorId: "other" }, 1)).rejects.toThrow(/denied/);
    await expect(records.events(key, { ...reader, tenantId: "other" }, 1)).rejects.toThrow(/denied/);
    await store.update(
      key,
      (task) => {
        task.state = "completed";
        delete task.lease;
      },
      fence,
    );
    const reconnected = new DurableRunRecords(store, {
      durable: false,
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    });
    expect((await reconnected.events(key, reader, 4))[0]).toMatchObject({
      sequence: 5,
      type: "task.state",
      data: { state: "completed" },
    });
    await expect(records.append(key, fence, "late", null)).rejects.toThrow(/lease/i);
  });
  it("retains immutable snapshots and rejects unauthorized, corrupted, expired or missing objects", async () => {
    const { store, records, blobs, objects, advance } = await fixture();
    const snapshot = {
      history: [{ role: "assistant", content: "done", providerExtras: { opaque: "fixture" } }],
      state: { count: 1 },
    };
    await records.checkpoint(key, fence, "one", snapshot, 5000);
    const restored = new DurableRunRecords(store, blobs, { now: () => 1000 });
    expect(await restored.snapshot(key, reader, "one")).toEqual(snapshot);
    await expect(restored.snapshot(key, { ...reader, actorId: "other" }, "one")).rejects.toThrow(/denied/);
    await expect(records.checkpoint(key, fence, "one", { different: true }, 5000)).rejects.toThrow(/immutable/);
    advance(7000);
    await expect(records.snapshot(key, reader, "one")).rejects.toThrow(/expired/);
    const blobKey = [...objects.keys()][0]!;
    objects.set(blobKey, new Uint8Array([1]));
    await expect(restored.snapshot(key, reader, "one")).rejects.toThrow(/digest/);
    objects.delete(blobKey);
    await expect(restored.snapshot(key, reader, "one")).rejects.toThrow(/missing/);
  });
  it("cannot commit a blob reference after its lease is replaced", async () => {
    const { store } = await fixture();
    let writes = 0;
    const records = new DurableRunRecords(store, {
      durable: false,
      async put() {
        writes++;
        await store.update(key, (task) => {
          task.fence++;
          task.lease = { workerId: "new", fence: task.fence, expiresAt: 100_000 };
        });
      },
      get: async () => null,
      delete: async () => {},
    });
    await expect(
      records.putArtifact(key, fence, {
        id: "output",
        bytes: new Uint8Array([1]),
        mimeType: "text/plain",
        ttlMs: 1000,
      }),
    ).rejects.toThrow(/lease/i);
    expect(writes).toBe(1);
    expect((await store.get(key))?.extensions["agentium.records.v1"]).not.toHaveProperty("artifacts.output");
  });
});
