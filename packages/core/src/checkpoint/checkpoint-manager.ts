import { v4 as uuidv4 } from "uuid";
import type { ChatMessage, TokenUsage } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import { InMemoryStorage } from "../storage/in-memory.js";

const NAMESPACE = "checkpoints";

export interface Checkpoint {
  id: string;
  runId: string;
  roundtrip: number;
  messages: ChatMessage[];
  tokenUsage: TokenUsage;
  sessionState: Record<string, unknown>;
  timestamp: Date;
}

export class CheckpointManager {
  private storage: StorageDriver;

  constructor(storage?: StorageDriver) {
    this.storage = storage ?? new InMemoryStorage();
  }

  async save(checkpoint: Omit<Checkpoint, "id" | "timestamp">): Promise<string> {
    const id = uuidv4();
    const full: Checkpoint = {
      ...checkpoint,
      id,
      timestamp: new Date(),
    };

    await this.storage.set(NAMESPACE, `${checkpoint.runId}:${id}`, full);
    return id;
  }

  async load(checkpointId: string): Promise<Checkpoint | null> {
    const all = await this.storage.list<Checkpoint>(NAMESPACE);
    const found = all.find((entry) => entry.value.id === checkpointId);
    return found?.value ?? null;
  }

  async list(runId: string): Promise<Checkpoint[]> {
    const all = await this.storage.list<Checkpoint>(NAMESPACE, `${runId}:`);
    return all.map((entry) => entry.value).sort((a, b) => a.roundtrip - b.roundtrip);
  }

  async rollback(checkpointId: string): Promise<Checkpoint | null> {
    const checkpoint = await this.load(checkpointId);
    if (!checkpoint) return null;

    // Delete all checkpoints after this one in the same run
    const all = await this.list(checkpoint.runId);
    for (const cp of all) {
      if (cp.roundtrip > checkpoint.roundtrip) {
        await this.storage.delete(NAMESPACE, `${checkpoint.runId}:${cp.id}`);
      }
    }

    return checkpoint;
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const all = await this.storage.list<Checkpoint>(NAMESPACE);
    let pruned = 0;
    for (const entry of all) {
      const ts = new Date(entry.value.timestamp).getTime();
      if (ts < cutoff) {
        await this.storage.delete(NAMESPACE, entry.key);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Create an onRoundtripComplete hook for auto-checkpointing.
   */
  toOnRoundtripCompleteHook(
    runId: string,
    getMessages: () => ChatMessage[],
    getSessionState: () => Record<string, unknown>,
    // biome-ignore lint/suspicious/noConfusingVoidType: matches LoopHooks interface
  ): (roundtrip: number, tokensSoFar: TokenUsage) => Promise<{ stop?: boolean } | void> {
    return async (roundtrip: number, tokensSoFar: TokenUsage) => {
      await this.save({
        runId,
        roundtrip,
        messages: [...getMessages()],
        tokenUsage: tokensSoFar,
        sessionState: { ...getSessionState() },
      });
    };
  }
}
