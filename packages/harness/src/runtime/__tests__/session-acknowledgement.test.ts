import { describe, expect, it, vi } from "vitest";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";
import type { HarnessSessionLease, HarnessSessionStore } from "../session-bindings.js";

const start = { identity: { tenantId: "tenant", userId: "user" }, sessionId: "ack" };
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function runtime(lease: HarnessSessionLease, execute: ExecutionDriver["start"] = async () => ({ text: "candidate" })) {
  const store: HarnessSessionStore = {
    guarantees: { durable: true, compareAndSwap: true, singleWriter: "distributed" },
    acquire: async () => lease,
  };
  return new HarnessRuntime({
    sessionStore: store,
    grants: { toolIds: [], modelRoles: ["main"] },
    driver: {
      id: "ack-fixture",
      version: 1,
      capabilities: { controls: [], durable: false, controlledExecution: true, policyCoverage: "local" },
      start: execute,
    },
  });
}
const read = () => ({ history: [], state: {}, revision: 0, replayable: true });

describe("session acknowledgement", () => {
  it("keeps the result and writer lease pending until commit acknowledgement", async () => {
    const entered = deferred();
    const ack = deferred();
    const release = vi.fn();
    const handle = runtime({
      read,
      commit: async () => {
        entered.resolve();
        await ack.promise;
      },
      release,
    }).start("task", start);
    let settled = false;
    void handle.result().then(() => {
      settled = true;
    });
    await entered.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    ack.resolve();
    expect((await handle.result()).status).toBe("completed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("awaits release acknowledgement before emitting the terminal result", async () => {
    const entered = deferred();
    const ack = deferred();
    const handle = runtime({
      read,
      commit: () => {},
      release: async () => {
        entered.resolve();
        await ack.promise;
      },
    }).start("task", start);
    let settled = false;
    void handle.result().then(() => {
      settled = true;
    });
    await entered.promise;
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    ack.resolve();
    expect((await handle.result()).status).toBe("completed");
  });

  it("does not retry a commit with unknown acknowledgement and retains the candidate", async () => {
    const commit = vi.fn(() => {
      throw new Error("ack lost after write");
    });
    const release = vi.fn();
    const result = await runtime({ read, commit, release }).run("task", start);
    expect(commit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "failed",
      text: "candidate",
      partial: true,
      reason: { code: "session_commit_failed" },
      cleanupDiagnostics: ["session_commit_outcome_unknown"],
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("makes one partial commit after execution failure and preserves cleanup diagnostics", async () => {
    const commit = vi.fn(async (_snapshot: Parameters<HarnessSessionLease["commit"]>[0]) => {
      throw new Error("partial write failed");
    });
    const release = vi.fn(async () => {
      throw new Error("release failed");
    });
    const result = await runtime({ read, commit, release }, async () => {
      throw new Error("driver failed");
    }).run("task", start);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ replayable: false });
    expect(result).toMatchObject({
      status: "failed",
      reason: { message: "driver failed" },
      cleanupDiagnostics: ["partial_history_commit_failed", "session_release_failed"],
    });
  });

  it("acknowledges cancellation during commit without a second driver or write", async () => {
    const entered = deferred();
    const ack = deferred();
    const execute = vi.fn(async () => ({ text: "candidate" }));
    const commit = vi.fn(async () => {
      entered.resolve();
      await ack.promise;
    });
    const release = vi.fn();
    const handle = runtime({ read, commit, release }, execute).start("task", start);
    await entered.promise;
    handle.cancel("cancel during storage acknowledgement");
    expect(release).not.toHaveBeenCalled();
    ack.resolve();
    expect((await handle.result()).status).toBe("cancelled");
    expect(commit).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
