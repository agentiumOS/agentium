import type { StorageDriver } from "../storage/driver.js";
import type { StepResult } from "./types.js";

/**
 * Per-step workflow checkpoint. Captures the state immediately after a step
 * completed so the workflow can replay or fork from that exact point.
 */
export interface WorkflowCheckpoint<TState> {
  /** Stable identifier - `${runId}:${stepIndex}`. */
  id: string;
  runId: string;
  workflowName: string;
  stepIndex: number;
  /** Name of the step whose completion produced this checkpoint. */
  stepName: string;
  /** State immediately AFTER the step ran. */
  state: TState;
  /** Cumulative step results up to and including this step. */
  stepResults: StepResult[];
  timestamp: number;
}

export interface WorkflowCheckpointStore<TState> {
  save(checkpoint: WorkflowCheckpoint<TState>): Promise<void>;
  load(checkpointId: string): Promise<WorkflowCheckpoint<TState> | null>;
  listForRun(runId: string): Promise<WorkflowCheckpoint<TState>[]>;
  delete(checkpointId: string): Promise<void>;
}

const NS = "workflow:checkpoints";

/**
 * Default checkpoint store backed by a `StorageDriver`. Use any existing driver
 * (in-memory, SQLite, Postgres, MongoDB, Redis, ...) to get persistence.
 */
export class StorageBackedCheckpointStore<TState> implements WorkflowCheckpointStore<TState> {
  /** Maximum number of checkpoints kept per run. Older ones are deleted. */
  readonly keepLastN: number;
  constructor(
    private readonly storage: StorageDriver,
    options: { keepLastN?: number } = {},
  ) {
    this.keepLastN = options.keepLastN ?? 0;
  }

  async save(cp: WorkflowCheckpoint<TState>): Promise<void> {
    await this.storage.set(NS, cp.id, cp);
    if (this.keepLastN > 0) {
      const all = await this.listForRun(cp.runId);
      all.sort((a, b) => a.stepIndex - b.stepIndex);
      const overflow = all.length - this.keepLastN;
      if (overflow > 0) {
        for (let i = 0; i < overflow; i++) await this.delete(all[i].id);
      }
    }
  }

  async load(checkpointId: string): Promise<WorkflowCheckpoint<TState> | null> {
    return this.storage.get<WorkflowCheckpoint<TState>>(NS, checkpointId);
  }

  async listForRun(runId: string): Promise<WorkflowCheckpoint<TState>[]> {
    const entries = await this.storage.list<WorkflowCheckpoint<TState>>(NS, `${runId}:`);
    return entries.map((e) => e.value);
  }

  async delete(checkpointId: string): Promise<void> {
    await this.storage.delete(NS, checkpointId);
  }
}
