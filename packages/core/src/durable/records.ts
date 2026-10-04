import { createHash } from "node:crypto";
import { durableCanonical, durableId, durableInteger } from "./store.js";
import type {
  DurableFence,
  DurableJSON,
  DurableTaskInput,
  DurableTaskKey,
  DurableTaskRecord,
  DurableTaskStore,
} from "./types.js";

export interface DurableReader {
  tenantId: string;
  actorId: string;
}
export interface DurableRunEvent {
  sequence: number;
  type: string;
  at: number;
  attemptId: string | null;
  data: DurableJSON;
}
export interface DurableArtifactReference {
  id: string;
  blobKey: string;
  digest: string;
  bytes: number;
  mimeType: string;
  expiresAt: number;
}
/** Host-owned object storage. put must never replace different bytes at an existing key. */
export interface DurableBlobStore {
  readonly durable: boolean;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
interface Records {
  next: number;
  events: DurableRunEvent[];
  artifacts: Record<string, DurableArtifactReference>;
  snapshots: Record<string, { artifactId: string; digest: string }>;
}
const recordsKey = "agentium.records.v1";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (value: unknown): DurableJSON => JSON.parse(durableCanonical(value));
function readRecords(task: DurableTaskRecord): Records {
  return (
    (task.extensions[recordsKey] as unknown as Records | undefined) ?? {
      next: 1,
      events: [],
      artifacts: {},
      snapshots: {},
    }
  );
}
function writeRecords(task: DurableTaskRecord, records: Records): void {
  task.extensions[recordsKey] = json(records);
}
function checkReader(task: DurableTaskRecord, identity: DurableReader): void {
  if (task.identity.tenantId !== identity.tenantId || task.identity.actorId !== identity.actorId)
    throw new Error("Durable record access denied");
}
export class DurableEventGapError extends Error {
  constructor(
    readonly earliest: number,
    readonly latest: number,
  ) {
    super(`Durable event history gap; retained sequence ${earliest} through ${latest}`);
    this.name = "DurableEventGapError";
  }
}

/** A single task aggregate holds sequenced events and immutable object references.
 * Blobs are written first: a failed fenced reference commit can leave an orphan blob,
 * never a committed reference to bytes that have not been stored. Hosts own orphan GC.
 */
export class DurableRunRecords {
  constructor(
    readonly store: DurableTaskStore,
    private readonly blobs: DurableBlobStore,
    private readonly options: {
      maxEvents?: number;
      maxEventBytes?: number;
      maxArtifactBytes?: number;
      now?: () => number;
    } = {},
  ) {
    for (const count of [
      options.maxEvents ?? 256,
      options.maxEventBytes ?? 32768,
      options.maxArtifactBytes ?? 1_000_000,
    ]) {
      durableInteger(count);
      if (count < 1) throw new Error("Record limits must be positive");
    }
  }
  private async owned(key: DurableTaskKey, identity: DurableReader): Promise<DurableTaskRecord> {
    if (identity.tenantId !== key.tenantId) throw new Error("Durable record access denied");
    const task = await this.store.get(key);
    if (!task) throw new Error("Durable record not found");
    checkReader(task, identity);
    return task;
  }
  async append(key: DurableTaskKey, fence: DurableFence, type: string, data: DurableJSON): Promise<DurableRunEvent> {
    durableId(type);
    if (Buffer.byteLength(durableCanonical(data)) > (this.options.maxEventBytes ?? 32768))
      throw new Error("Durable event byte limit exceeded");
    let event!: DurableRunEvent;
    await this.store.update(
      key,
      (task, now) => {
        const records = readRecords(task);
        event = {
          sequence: records.next++,
          type,
          at: now,
          attemptId: task.attempts.at(-1)?.id ?? null,
          data: json(data),
        };
        records.events.push(event);
        records.events = records.events.slice(-(this.options.maxEvents ?? 256));
        writeRecords(task, records);
      },
      fence,
    );
    return structuredClone(event);
  }
  async events(key: DurableTaskKey, identity: DurableReader, after = 0): Promise<DurableRunEvent[]> {
    durableInteger(after);
    const records = readRecords(await this.owned(key, identity));
    const earliest = records.events[0]?.sequence ?? records.next;
    if (after < earliest - 1 || after >= records.next) throw new DurableEventGapError(earliest, records.next - 1);
    return structuredClone(records.events.filter((event) => event.sequence > after));
  }
  async putArtifact(
    key: DurableTaskKey,
    fence: DurableFence,
    artifact: { id: string; bytes: Uint8Array; mimeType: string; ttlMs: number },
  ): Promise<DurableArtifactReference> {
    durableId(artifact.id);
    durableId(artifact.mimeType);
    durableInteger(artifact.ttlMs);
    if (!artifact.ttlMs || artifact.bytes.byteLength > (this.options.maxArtifactBytes ?? 1_000_000))
      throw new Error("Invalid artifact size or retention");
    const bytes = Uint8Array.from(artifact.bytes);
    const hash = digest(bytes);
    const blobKey = createHash("sha256")
      .update(durableCanonical([key.tenantId, key.taskId, artifact.id, hash]))
      .digest("hex");
    // Validate ownership before external object IO, then fence again at reference commit.
    await this.store.update(key, () => {}, fence);
    await this.blobs.put(blobKey, bytes);
    let reference!: DurableArtifactReference;
    await this.store.update(
      key,
      (task, now) => {
        const records = readRecords(task);
        const existing = records.artifacts[artifact.id];
        if (existing) {
          if (existing.digest !== hash || existing.mimeType !== artifact.mimeType)
            throw new Error("Artifact ID is immutable");
          reference = existing;
          return;
        }
        const expiresAt = now + artifact.ttlMs;
        if (!Number.isSafeInteger(expiresAt)) throw new Error("Artifact expiry overflow");
        reference = {
          id: artifact.id,
          blobKey,
          digest: hash,
          bytes: bytes.byteLength,
          mimeType: artifact.mimeType,
          expiresAt,
        };
        records.artifacts[artifact.id] = reference;
        writeRecords(task, records);
      },
      fence,
    );
    return structuredClone(reference);
  }
  async artifact(key: DurableTaskKey, identity: DurableReader, id: string): Promise<Uint8Array> {
    durableId(id);
    const task = await this.owned(key, identity);
    const reference = readRecords(task).artifacts[id];
    if (!reference || reference.expiresAt <= (this.options.now?.() ?? Date.now()))
      throw new Error("Artifact missing or expired");
    const bytes = await this.blobs.get(reference.blobKey);
    if (!bytes || bytes.byteLength !== reference.bytes || digest(bytes) !== reference.digest)
      throw new Error("Artifact missing or digest mismatch");
    return Uint8Array.from(bytes);
  }
  async checkpoint(
    key: DurableTaskKey,
    fence: DurableFence,
    id: string,
    snapshot: DurableJSON,
    ttlMs: number,
  ): Promise<string> {
    durableId(id);
    const artifact = await this.putArtifact(key, fence, {
      id: `snapshot:${id}`,
      bytes: Buffer.from(durableCanonical(snapshot)),
      mimeType: "application/json",
      ttlMs,
    });
    await this.store.update(
      key,
      (task) => {
        const records = readRecords(task);
        records.snapshots[id] = { artifactId: artifact.id, digest: artifact.digest };
        writeRecords(task, records);
      },
      fence,
    );
    return artifact.digest;
  }
  async snapshot(key: DurableTaskKey, identity: DurableReader, id: string): Promise<DurableJSON> {
    durableId(id);
    const task = await this.owned(key, identity);
    const reference = readRecords(task).snapshots[id];
    if (!reference) throw new Error("Snapshot not found");
    const bytes = await this.artifact(key, identity, reference.artifactId);
    if (digest(bytes) !== reference.digest) throw new Error("Snapshot digest mismatch");
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
}

/** Add lifecycle events in the SAME atomic update as task state. Use this wrapped
 * store for both the supervisor and record services to retain one authoritative log. */
export class JournaledDurableTaskStore implements DurableTaskStore {
  readonly capabilities: DurableTaskStore["capabilities"];
  constructor(
    private readonly inner: DurableTaskStore,
    private readonly maxEvents = 256,
  ) {
    this.capabilities = inner.capabilities;
    durableInteger(maxEvents);
    if (maxEvents < 1) throw new Error("Event retention must be positive");
  }
  create(input: DurableTaskInput): Promise<DurableTaskRecord> {
    return this.inner.create(input);
  }
  get(key: DurableTaskKey): Promise<DurableTaskRecord | null> {
    return this.inner.get(key);
  }
  update(
    key: DurableTaskKey,
    mutate: (draft: DurableTaskRecord, now: number) => void,
    guard?: DurableFence,
  ): Promise<DurableTaskRecord> {
    return this.inner.update(
      key,
      (task, now) => {
        const before = task.state;
        const result: unknown = mutate(task, now);
        if (result && typeof (result as PromiseLike<unknown>).then === "function")
          throw new Error("Durable update must be synchronous");
        if (task.state !== before) {
          const records = readRecords(task);
          records.events.push({
            sequence: records.next++,
            type: "task.state",
            at: now,
            attemptId: task.attempts.at(-1)?.id ?? null,
            data: { before, state: task.state },
          });
          records.events = records.events.slice(-this.maxEvents);
          writeRecords(task, records);
        }
      },
      guard,
    );
  }
}
