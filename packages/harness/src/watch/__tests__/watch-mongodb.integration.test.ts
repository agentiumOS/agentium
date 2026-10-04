import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mongoWatch } from "./fixtures/mongo-watch.js";

const uri = process.env.AGENTIUM_DURABLE_MONGO_URI ?? "mongodb://127.0.0.1:27319/?directConnection=true";
const database = `agentium_watch_fixture_${randomUUID().replaceAll("-", "")}`;
const children = new Set<ChildProcess>();
async function crash(id: string, phase: string) {
  const child = fork(
    fileURLToPath(new URL("./fixtures/watch-worker.ts", import.meta.url)),
    [uri, database, id, phase],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Watch crash worker timeout: ${errors}`));
    }, 15000);
    child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code) reject(new Error(`Watch worker ${code}: ${errors}`));
    });
  });
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  children.delete(child);
  await new Promise((resolve) => setTimeout(resolve, 380));
}
describe.skipIf(process.env.AGENTIUM_DURABLE_MONGO_TEST !== "1")(
  "real Mongo watch cursor/outbox worker recovery",
  () => {
    afterAll(async () => {
      for (const child of children) child.kill("SIGKILL");
      const f = await mongoWatch(uri, database, "cleanup");
      try {
        await f.client.db(database).dropDatabase();
      } finally {
        await f.close();
      }
    });
    it("recovers committed cursor and digest after death before scheduling/acknowledgement", async () => {
      await crash("cursor", "cursor");
      const f = await mongoWatch(uri, database, "cursor");
      try {
        expect(await f.watch.inspect()).toMatchObject({ cursor: "11", pending: [{ id: "event-11" }] });
        await f.watch.activate(); // Repairs persisted schedule intent.
        await f.watch.poll();
        await f.watch.flush();
        expect(await f.effects.countDocuments()).toBe(1);
        expect(Object.values((await f.watch.inspect()).outbox)).toHaveLength(1);
      } finally {
        await f.close();
      }
    }, 20000);
    it("dispatches a persisted digest once after death before its first effect", async () => {
      await crash("prepared", "prepared");
      const f = await mongoWatch(uri, database, "prepared");
      try {
        const before = await f.watch.inspect();
        expect(Object.values(before.outbox)[0].reservedDay).not.toBeNull();
        await f.watch.flush();
        await f.watch.flush();
        expect(Object.values((await f.store.get(f.watch.key))!.actions)).toHaveLength(1);
        expect(Object.values((await f.watch.inspect()).outbox)[0].state).toBe("confirmed");
      } finally {
        await f.close();
      }
    }, 20000);
    it("reconciles a real effect after death before confirmation without sending twice, including after delete", async () => {
      await crash("effect", "effect");
      const f = await mongoWatch(uri, database, "effect");
      try {
        const count = await f.effects.countDocuments();
        await expect(f.watch.flush()).rejects.toThrow();
        await f.watch.delete();
        const id = Object.keys((await f.watch.inspect()).outbox)[0];
        await f.watch.reconcile(id);
        await f.watch.flush();
        expect(await f.effects.countDocuments()).toBe(count);
        expect((await f.watch.inspect()).outbox[id].state).toBe("confirmed");
        expect((await f.store.get(f.watch.key))?.state).toBe("running");
      } finally {
        await f.close();
      }
    }, 20000);
  },
);
