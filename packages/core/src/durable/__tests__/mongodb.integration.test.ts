import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DurableActionLedger } from "../actions.js";
import { MongoDBDurableTaskStore } from "../mongodb.js";
import { MongoDBDurableDocumentConnector } from "../mongodb-connector.js";
import { DurableTaskSupervisor } from "../supervisor.js";
import type { DurableLease, DurableTaskInput, DurableTaskRecord } from "../types.js";

const enabled = process.env.AGENTIUM_DURABLE_MONGO_TEST === "1";
// Explicit isolated test endpoint; never infer an application database/credential URI.
const uri = process.env.AGENTIUM_DURABLE_MONGO_URI ?? "mongodb://127.0.0.1:27319/?directConnection=true";
const database = `agentium_durable_fixture_${randomUUID().replaceAll("-", "")}`;
let store: MongoDBDurableTaskStore;
let client: any;
let supervisor: DurableTaskSupervisor;
const children = new Set<ChildProcess>();
function input(id: string): DurableTaskInput {
  return {
    id,
    identity: { tenantId: "tenant", actorId: "actor", sessionId: "session", runId: id, rootRunId: id },
    manifestHash: "sha256:fixture",
    inputRef: "fixture-input",
    policyRevision: 1,
    grantRefs: ["fixture-grant"],
    budget: { maxAttempts: 20 },
  };
}
function launch(
  taskId: string,
  phase: string,
): Promise<{ child: ChildProcess; message: { phase: string; record?: DurableTaskRecord; lease?: DurableLease } }> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url)),
      [uri, database, taskId, phase],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    children.add(child);
    let errors = "";
    child.stderr?.on("data", (data) => {
      errors += data;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Fixture worker timeout: ${errors}`));
    }, 15000);
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolve({ child, message: message as never });
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      children.delete(child);
      if (code) reject(new Error(`Fixture worker exited ${code}: ${errors}`));
    });
  });
}
async function kill(child: ChildProcess) {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}
async function expire() {
  await new Promise((resolve) => setTimeout(resolve, 380));
}
describe.skipIf(!enabled)("MongoDB durable single-task CAS and real worker crashes", () => {
  beforeAll(async () => {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(uri);
    await client.connect();
    store = new MongoDBDurableTaskStore(uri, { database });
    await store.initialize();
    supervisor = new DurableTaskSupervisor(store, { leaseMs: 300, pollMs: 50 });
  }, 20000);
  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await client?.db(database).dropDatabase();
    await store?.close();
    await client?.close();
  });
  it("arbitrates two independent processes and fences a killed expired worker", async () => {
    await store.create(input("race"));
    const key = { tenantId: "tenant", taskId: "race" };
    const pair = await Promise.all([launch("race", "claim"), launch("race", "claim")]);
    const winners = pair.filter((p) => p.message.record);
    expect(winners).toHaveLength(1);
    const stale = winners[0].message.record!.lease!;
    await Promise.all(pair.map((p) => kill(p.child)));
    await expire();
    const next = await supervisor.claim(key, "replacement");
    expect(next!.fence).toBe(2);
    await expect(
      store.update(
        key,
        (d) => {
          d.state = "completed";
        },
        stale,
      ),
    ).rejects.toThrow(/expired|fenced/);
    await expect(supervisor.release(key, stale)).rejects.toThrow();
    await supervisor.release(key, next!.lease!);
  }, 20000);
  it("commits extension increments atomically across independent store clients", async () => {
    await store.create(input("cas"));
    const other = new MongoDBDurableTaskStore(uri, { database, maxConflicts: 100 });
    await other.initialize();
    const key = { tenantId: "tenant", taskId: "cas" };
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          (i % 2 ? store : other).update(key, (d) => {
            d.extensions.n = Number(d.extensions.n ?? 0) + 1;
          }),
        ),
      );
      expect((await store.get(key))?.extensions.n).toBe(20);
    } finally {
      await other.close();
    }
  });
  it("safely retries prepared intent after process death before dispatch", async () => {
    await store.create(input("prepared"));
    const key = { tenantId: "tenant", taskId: "prepared" };
    const worker = await launch("prepared", "prepared");
    await kill(worker.child);
    await expire();
    const connector = new MongoDBDurableDocumentConnector(client.db(database).collection("effects"), "fixture-inbox");
    const result = await supervisor.run(key, "restarted", (ctx) =>
      ctx.actions.execute(
        { id: "send", connectorVersion: connector.version, destination: "fixture-inbox", args: { text: "fixture" } },
        connector,
      ),
    );
    expect(result.state).toBe("completed");
    expect(await client.db(database).collection("effects").countDocuments()).toBe(1);
  }, 20000);
  it("reconciles one actual committed effect after process death before confirmation, never auto-replaying it", async () => {
    await store.create(input("effect"));
    const key = { tenantId: "tenant", taskId: "effect" };
    const worker = await launch("effect", "effect");
    await kill(worker.child);
    await expire();
    let executed = false;
    await expect(
      supervisor.run(key, "replacement", async () => {
        executed = true;
      }),
    ).rejects.toThrow(/unknown/);
    expect(executed).toBe(false);
    const claimed = (await supervisor.claim(key, "reconciler"))!;
    const connector = new MongoDBDurableDocumentConnector(client.db(database).collection("effects"), "fixture-inbox");
    await new DurableActionLedger(store, key, claimed.lease!).reconcile("send", connector);
    await supervisor.release(key, claimed.lease!);
    const result = await supervisor.run(key, "resume", (ctx) =>
      ctx.actions.execute(
        { id: "send", connectorVersion: connector.version, destination: "fixture-inbox", args: { text: "fixture" } },
        connector,
      ),
    );
    expect(result.state).toBe("completed");
    expect(
      await client.db(database).collection("effects").countDocuments({ _id: result.actions.send.idempotencyKey }),
    ).toBe(1);
  }, 20000);
  it("persists approval and cancellation across process restart without dispatch", async () => {
    await store.create(input("approval"));
    const key = { tenantId: "tenant", taskId: "approval" };
    const worker = await launch("approval", "approval");
    await kill(worker.child);
    expect((await store.get(key))?.state).toBe("awaiting_approval");
    await supervisor.cancel(key, "operator");
    const canceled = await supervisor.run(key, "cancel-worker", async () => {
      throw new Error("must never invoke driver");
    });
    expect(canceled.state).toBe("canceled");
    expect(
      await client.db(database).collection("effects").countDocuments({ _id: canceled.actions.send.idempotencyKey }),
    ).toBe(0);
  }, 20000);
});
