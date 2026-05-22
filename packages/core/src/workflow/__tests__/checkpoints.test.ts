import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { StorageBackedCheckpointStore } from "../checkpoints.js";
import { Workflow } from "../workflow.js";

interface State extends Record<string, unknown> {
  count: number;
  log: string[];
}

function makeWorkflow(checkpointStore?: any) {
  return new Workflow<State>({
    name: "test",
    register: false,
    initialState: { count: 0, log: [] },
    checkpointStore,
    steps: [
      {
        name: "increment-1",
        run: async (s) => ({ count: s.count + 1, log: [...s.log, "s1"] }),
      },
      {
        name: "increment-2",
        run: async (s) => ({ count: s.count + 10, log: [...s.log, "s2"] }),
      },
      {
        name: "increment-3",
        run: async (s) => ({ count: s.count + 100, log: [...s.log, "s3"] }),
      },
    ],
  });
}

describe("Workflow checkpoints + time travel", () => {
  it("saves a checkpoint after each step", async () => {
    const storage = new InMemoryStorage();
    const store = new StorageBackedCheckpointStore<State>(storage);
    const wf = makeWorkflow(store);

    const result = await wf.runWithCheckpoints();
    expect(result.state.count).toBe(111);

    const checkpoints = await wf.listCheckpoints(result.runId);
    expect(checkpoints.length).toBe(3);
    expect(checkpoints.map((c) => c.state.count).sort((a, b) => a - b)).toEqual([1, 11, 111]);
  });

  it("replays from the middle checkpoint", async () => {
    const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
    const wf = makeWorkflow(store);
    const initial = await wf.runWithCheckpoints();

    const checkpoints = await wf.listCheckpoints(initial.runId);
    checkpoints.sort((a, b) => a.stepIndex - b.stepIndex);
    const mid = checkpoints[0]; // after step 0 only - state {count:1}

    const replayed = await wf.replay(mid.id);
    expect(replayed.state.count).toBe(111);
    expect(replayed.runId).not.toBe(initial.runId);
  });

  it("forks with a state mutation", async () => {
    const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
    const wf = makeWorkflow(store);
    const initial = await wf.runWithCheckpoints();

    const checkpoints = await wf.listCheckpoints(initial.runId);
    checkpoints.sort((a, b) => a.stepIndex - b.stepIndex);
    const afterStep0 = checkpoints[0]; // count: 1

    // Replace count with 50 before running remaining steps.
    const forked = await wf.fork(afterStep0.id, (state) => ({ count: 50, log: state.log }));
    // step-2 adds 10, step-3 adds 100 -> 160
    expect(forked.state.count).toBe(160);
  });

  it("throws when checkpointStore not configured", async () => {
    const wf = makeWorkflow(); // no store
    await expect(wf.runWithCheckpoints()).rejects.toThrow(/checkpointStore/);
  });

  it("throws on unknown checkpoint id", async () => {
    const store = new StorageBackedCheckpointStore<State>(new InMemoryStorage());
    const wf = makeWorkflow(store);
    await wf.runWithCheckpoints();
    await expect(wf.replay("nope")).rejects.toThrow(/not found/);
  });

  it("retention policy keepLastN trims older checkpoints", async () => {
    const storage = new InMemoryStorage();
    const store = new StorageBackedCheckpointStore<State>(storage, { keepLastN: 2 });
    const wf = makeWorkflow(store);
    const result = await wf.runWithCheckpoints();
    const checkpoints = await wf.listCheckpoints(result.runId);
    expect(checkpoints.length).toBe(2);
  });
});
