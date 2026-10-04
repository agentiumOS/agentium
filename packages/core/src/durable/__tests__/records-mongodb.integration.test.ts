import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MongoDurableBlobStore } from "../blob-mongodb.js";
import { MongoDBDurableTaskStore } from "../mongodb.js";
import { DurableRunRecords, JournaledDurableTaskStore } from "../records.js";
import { DurableTaskSupervisor } from "../supervisor.js";

it.skipIf(process.env.AGENTIUM_DURABLE_MONGO_TEST !== "1")(
  "reopens scoped snapshots and terminal event cursors from real MongoDB",
  async () => {
    const uri = process.env.AGENTIUM_DURABLE_MONGO_URI ?? "mongodb://127.0.0.1:27319/?directConnection=true";
    const database = `agentium_records_${randomUUID().replaceAll("-", "")}`;
    const { MongoClient } = await import("mongodb");
    const cleanup = new MongoClient(uri);
    const first = new MongoDBDurableTaskStore(uri, { database });
    const second = new MongoDBDurableTaskStore(uri, { database });
    const blobs = new MongoDurableBlobStore(uri, { database });
    const reopenedBlobs = new MongoDurableBlobStore(uri, { database });
    try {
      await Promise.all([first.initialize(), second.initialize(), cleanup.connect()]);
      const store = new JournaledDurableTaskStore(first);
      const supervisor = new DurableTaskSupervisor(store);
      const records = new DurableRunRecords(store, blobs);
      const key = { tenantId: "tenant", taskId: "task" };
      const reader = { tenantId: "tenant", actorId: "actor" };
      await supervisor.create({
        id: "task",
        identity: { ...reader, runId: "run", rootRunId: "run", sessionId: "session" },
        manifestHash: "manifest",
        inputRef: "input",
        policyRevision: 1,
        grantRefs: [],
      });
      await supervisor.run(key, "worker", async (ctx) => {
        await records.checkpoint(
          key,
          ctx.lease,
          "snapshot",
          { history: [{ role: "assistant", content: "ok", providerExtras: { opaque: "retained" } }] },
          60000,
        );
        await records.append(key, ctx.lease, "text.delta", { text: "ok" });
      });
      await blobs.close();
      await first.close();
      const reopened = new DurableRunRecords(new JournaledDurableTaskStore(second), reopenedBlobs);
      const events = await reopened.events(key, reader);
      expect(events.at(-1)).toMatchObject({ type: "task.state", data: { state: "completed" } });
      expect(await reopened.events(key, reader, events.at(-1)!.sequence)).toEqual([]);
      expect(await reopened.snapshot(key, reader, "snapshot")).toEqual({
        history: [{ role: "assistant", content: "ok", providerExtras: { opaque: "retained" } }],
      });
      await expect(reopened.snapshot(key, { ...reader, actorId: "other" }, "snapshot")).rejects.toThrow(/denied/);
      const hash = "1".repeat(64);
      await Promise.all([reopenedBlobs.put(hash, new Uint8Array([1])), reopenedBlobs.put(hash, new Uint8Array([1]))]);
      await expect(reopenedBlobs.put(hash, new Uint8Array([2]))).rejects.toThrow(/collision/);
    } finally {
      await cleanup.db(database).dropDatabase();
      await Promise.all([first.close(), second.close(), blobs.close(), reopenedBlobs.close(), cleanup.close()]);
    }
  },
  20000,
);
