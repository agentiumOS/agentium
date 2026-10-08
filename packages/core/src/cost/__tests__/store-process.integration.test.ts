import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const workerPath = fileURLToPath(new URL("./fixtures/store-process-worker.ts", import.meta.url));
const children = new Set<ChildProcess>();
const workerMessageSchema = z.object({
  type: z.enum(["ready", "checkpoint", "result", "error"]),
  data: z.unknown().optional(),
  message: z.string().optional(),
});
type WorkerMessage = z.infer<typeof workerMessageSchema>;
type Backend = { kind: "sqlite" | "postgres"; location: string };

function worker(backend: Backend, tenantId: string, mode: string, attemptId?: string) {
  const child = fork(workerPath, [backend.kind, backend.location, tenantId, mode, ...(attemptId ? [attemptId] : [])], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const buffered: WorkerMessage[] = [];
  let waiting:
    | { type: WorkerMessage["type"]; resolve: (message: WorkerMessage) => void; reject: (error: Error) => void }
    | undefined;
  child.on("message", (raw: unknown) => {
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      waiting?.reject(new Error("Invalid fixture IPC message"));
      return;
    }
    const message = parsed.data;
    if (message.type === "error") {
      waiting?.reject(new Error(message.message));
      buffered.push(message);
      return;
    }
    if (waiting?.type === message.type) {
      const current = waiting;
      waiting = undefined;
      current.resolve(message);
    } else buffered.push(message);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (waiting) {
      waiting.reject(new Error(`Fixture exited before ${waiting.type} (${code ?? signal}): ${diagnostics}`));
      waiting = undefined;
    }
  });
  return {
    child,
    next(type: WorkerMessage["type"]): Promise<WorkerMessage> {
      const failed = buffered.find((message) => message.type === "error");
      if (failed) return Promise.reject(new Error(failed.message));
      const index = buffered.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        waiting = { type, resolve, reject };
      });
    },
    go() {
      child.send({ type: "go" });
    },
  };
}
async function run(backend: Backend, tenantId: string, mode: string) {
  const processWorker = worker(backend, tenantId, mode);
  await processWorker.next("ready");
  const result = processWorker.next("result");
  const exit = once(processWorker.child, "exit");
  processWorker.go();
  const message = await result;
  const [code, signal] = await exit;
  expect(code).toBe(0);
  expect(signal).toBeNull();
  return message.data;
}
async function killAtCheckpoint(backend: Backend, tenantId: string, mode: string) {
  const processWorker = worker(backend, tenantId, mode);
  await processWorker.next("ready");
  const checkpoint = processWorker.next("checkpoint");
  processWorker.go();
  const message = await checkpoint;
  const exit = once(processWorker.child, "exit");
  expect(processWorker.child.kill("SIGKILL")).toBe(true);
  const [code, signal] = await exit;
  expect(code).toBeNull();
  expect(signal).toBe("SIGKILL");
  return message.data;
}
async function processContract(backend: Backend) {
  const raceTenant = `process-race-${randomUUID()}`;
  const first = worker(backend, raceTenant, "reserve", "first");
  const second = worker(backend, raceTenant, "reserve", "second");
  await Promise.all([first.next("ready"), second.next("ready")]);
  const replies = Promise.all([first.next("result"), second.next("result")]);
  const exits = Promise.all([once(first.child, "exit"), once(second.child, "exit")]);
  first.go();
  second.go();
  const outcomes = await replies;
  expect(
    outcomes.map((result) => z.object({ accepted: z.boolean() }).parse(result.data).accepted).filter(Boolean),
  ).toHaveLength(1);
  for (const [code, signal] of await exits) {
    expect(code).toBe(0);
    expect(signal).toBeNull();
  }
  expect(await run(backend, raceTenant, "query")).toMatchObject({
    balances: [{ spent: "0", reserved: "0.7", unknownCount: 0 }],
  });

  const evidenceTenant = `process-evidence-${randomUUID()}`;
  expect(await killAtCheckpoint(backend, evidenceTenant, "crash-observation")).toMatchObject({
    observations: 1,
    assessments: 0,
    balances: [{ spent: "0", reserved: "0.1" }],
  });
  expect(await run(backend, evidenceTenant, "replay")).toMatchObject({
    costs: { total: "0.072", assessmentCount: 1, attemptCount: 1 },
    observations: 1,
    assessments: 1,
    balances: [{ spent: "0.072", reserved: "0", unknownCount: 0 }],
    reservation: { status: "settled" },
  });
  expect(await run(backend, evidenceTenant, "replay")).toMatchObject({
    costs: { total: "0.072", assessmentCount: 1 },
    observations: 1,
    assessments: 1,
    balances: [{ spent: "0.072", reserved: "0" }],
  });

  const settledTenant = `process-settled-${randomUUID()}`;
  expect(await killAtCheckpoint(backend, settledTenant, "crash-settled")).toMatchObject({
    costs: { total: "0.072" },
    balances: [{ spent: "0.072", reserved: "0" }],
    reservation: { status: "settled" },
  });
  expect(await run(backend, settledTenant, "replay")).toMatchObject({
    costs: { total: "0.072", assessmentCount: 1, attemptCount: 1 },
    observations: 1,
    assessments: 1,
    balances: [{ spent: "0.072", reserved: "0" }],
    reservation: { status: "settled" },
  });
  expect(await run(backend, `empty-${randomUUID()}`, "query")).toMatchObject({
    costs: { total: "0", assessmentCount: 0 },
    observations: 0,
    assessments: 0,
    reservation: null,
  });
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }),
  );
});

describe("accounting across actual processes and abrupt termination", () => {
  it("SQLite atomically reserves and recovers evidence/settlement after SIGKILL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentium-process-accounting-"));
    try {
      await processContract({ kind: "sqlite", location: join(directory, "usage.sqlite") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  it.skipIf(!process.env.AGENTIUM_COST_POSTGRES_TEST_URL)(
    "Postgres atomically reserves and recovers evidence/settlement after SIGKILL",
    async () => {
      const location = process.env.AGENTIUM_COST_POSTGRES_TEST_URL;
      if (!location) throw new Error("Disposable Postgres URL required");
      const parsed = new URL(location);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
        throw new Error("Subprocess integration requires a disposable loopback Postgres instance");
      await processContract({ kind: "postgres", location });
    },
    60000,
  );
});
