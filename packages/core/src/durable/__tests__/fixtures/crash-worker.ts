import { MongoClient } from "mongodb";
import { MongoDBDurableTaskStore } from "../../mongodb.js";
import { MongoDBDurableDocumentConnector } from "../../mongodb-connector.js";
import { DurableTaskSupervisor } from "../../supervisor.js";

const [uri, database, taskId, phase] = process.argv.slice(2);
const key = { tenantId: "tenant", taskId };
const store = new MongoDBDurableTaskStore(uri, { database });
await store.initialize();
const supervisor = new DurableTaskSupervisor(store, { leaseMs: 300, pollMs: 50 });
const client = new MongoClient(uri);
await client.connect();
const connector = new MongoDBDurableDocumentConnector(
  client.db(database).collection("effects") as never,
  "fixture-inbox",
);
const action = {
  id: "send",
  connectorVersion: connector.version,
  destination: "fixture-inbox",
  args: { text: "fixture" },
};
if (phase === "claim") {
  const claimed = await supervisor.claim(key, process.pid.toString());
  process.send?.({ phase: "claimed", record: claimed });
  await new Promise(() => {});
} else {
  await supervisor.run(key, process.pid.toString(), async (ctx) => {
    if (phase === "prepared") {
      await ctx.actions.prepare(action);
      process.send?.({ phase: "prepared", lease: ctx.lease });
      await new Promise(() => {});
    } else if (phase === "approval") {
      await ctx.actions.execute(
        { ...action, approval: { actorId: "reviewer", expiresAt: Date.now() + 60_000 } },
        connector,
      );
    } else if (phase === "effect") {
      await ctx.actions.execute(action, {
        version: connector.version,
        dispatch: async (a, signal) => {
          await connector.dispatch(a, signal);
          process.send?.({ phase: "effect", lease: ctx.lease });
          await new Promise(() => {});
          return { resultRef: "unreachable" };
        },
      });
    }
  });
  process.send?.({ phase: "approval" });
  await new Promise(() => {});
}
