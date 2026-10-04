import { MongoDBDurableDocumentConnector, MongoDBDurableTaskStore } from "@agentium/core";
import { MongoClient } from "mongodb";
import { DurableWatch } from "../../runtime.js";
import type { WatchDefinitionInput, WatchServices } from "../../types.js";
export function mongoDefinition(id: string): WatchDefinitionInput {
  return {
    id,
    version: 1,
    identity: { tenantId: "fixture", actorId: "owner" },
    sourceId: "fixture-source",
    sourceScope: "fixture-mailbox",
    destination: "fixture-inbox",
    channel: "fixture",
    policyRevision: 1,
    grantRefs: ["fixture-read", "fixture-send"],
    timeZone: "UTC",
    cooldownMs: 0,
  };
}
export async function mongoWatch(uri: string, database: string, id: string, phase?: string) {
  const store = new MongoDBDurableTaskStore(uri, { database });
  await store.initialize();
  const client = new MongoClient(uri);
  await client.connect();
  const effects = client.db(database).collection("watch_effects");
  const jobs = client.db(database).collection("watch_jobs");
  const connector = new MongoDBDurableDocumentConnector(effects as never, "fixture-inbox");
  const block = async (point: string) => {
    process.send?.({ phase: point });
    await new Promise(() => {});
  };
  let watch: DurableWatch;
  const services: WatchServices = {
    store,
    leaseMs: 300,
    source: {
      id: "fixture-source",
      scope: "fixture-mailbox",
      capabilities: { idempotentActivation: true, polling: true, push: false },
      baseline: async () => "10",
      activate: async (key) => ({ reference: key, expiresAt: Date.now() + 86400000 }),
      stop: async () => {},
      compareCursors: (a, b) => Number(BigInt(a) - BigInt(b)),
      read: async () => ({
        cursor: "11",
        events: [{ id: "event-11", occurredAt: 1, data: { text: "fixture" } }],
        resynced: false,
      }),
    },
    scheduler: {
      capabilities: { durable: true, idempotentUpsert: true },
      schedule: async (job) => {
        if (
          phase === "cursor" &&
          ((await store.get(watch.key))?.extensions.watch as { cursor: string } | undefined)?.cursor === "11"
        )
          await block("cursor");
        await jobs.updateOne(
          { key: job.key },
          { $set: job },
          { upsert: true, writeConcern: { w: "majority", j: true } },
        );
      },
      cancel: async (key) => {
        await jobs.deleteOne({ key }, { writeConcern: { w: "majority", j: true } });
      },
    },
    authorize: async (request) => {
      if (phase === "prepared" && request.notifications === 1) await block("prepared");
      return true;
    },
    notifications: {
      version: connector.version,
      destination: "fixture-inbox",
      channel: "fixture",
      dispatch: async (action, signal) => {
        const result = await connector.dispatch(action, signal);
        if (phase === "effect") await block("effect");
        return result;
      },
      reconcile: (action) => connector.reconcile(action),
    },
  };
  watch = new DurableWatch(mongoDefinition(id), services);
  return {
    watch,
    store,
    client,
    effects,
    close: async () => {
      await store.close();
      await client.close();
    },
  };
}
