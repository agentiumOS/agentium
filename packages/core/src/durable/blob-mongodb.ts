import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DurableBlobStore } from "./records.js";

const requireMongo = createRequire(import.meta.url);
/** Immutable content storage for bounded artifacts. Clients are optional and loaded
 * only on construction. Use a dedicated collection; Mongo's _id index is the CAS. */
export class MongoDurableBlobStore implements DurableBlobStore {
  readonly durable = true;
  private client: any;
  private collection: any;
  private ready: Promise<void> | undefined;
  constructor(
    uri: string,
    private readonly options: { database?: string; collection?: string; maxBytes?: number } = {},
  ) {
    const max = options.maxBytes ?? 4_000_000;
    if (!Number.isSafeInteger(max) || max < 1 || max > 8_000_000)
      throw new Error("Mongo artifact limit must be 1–8000000 bytes");
    try {
      const { MongoClient } = requireMongo("mongodb");
      this.client = new MongoClient(uri, { writeConcern: { w: "majority", j: true }, readPreference: "primary" });
    } catch (error: any) {
      if (error?.code === "MODULE_NOT_FOUND") throw new Error("Install mongodb (^6) to use MongoDurableBlobStore");
      throw error;
    }
  }
  async initialize(): Promise<void> {
    this.ready ??= (async () => {
      await this.client.connect();
      this.collection = this.client
        .db(this.options.database ?? "agentium")
        .collection(this.options.collection ?? "durable_artifacts");
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  private key(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Artifact blob keys must be scoped SHA-256 identifiers");
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.key(key);
    if (bytes.byteLength > (this.options.maxBytes ?? 4_000_000)) throw new Error("Artifact blob byte limit exceeded");
    const data = Buffer.from(bytes).toString("base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await this.initialize();
    try {
      await this.collection.updateOne({ _id: key }, { $setOnInsert: { data, hash } }, { upsert: true });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
    }
    const existing = await this.collection.findOne({ _id: key });
    if (!existing || existing.hash !== hash || existing.data !== data)
      throw new Error("Immutable artifact key collision");
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.key(key);
    await this.initialize();
    const record = await this.collection.findOne({ _id: key });
    if (!record) return null;
    const bytes = Buffer.from(record.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== record.hash)
      throw new Error("Artifact blob digest mismatch");
    return Uint8Array.from(bytes);
  }
  async delete(key: string): Promise<void> {
    this.key(key);
    await this.initialize();
    await this.collection.deleteOne({ _id: key });
  }
  async close(): Promise<void> {
    await this.ready?.catch(() => {});
    await this.client.close();
    this.ready = undefined;
  }
}
