import { createRequire } from "node:module";
import type { StorageDriver } from "./driver.js";

const _require = createRequire(import.meta.url);

export class MongoDBStorage implements StorageDriver {
  private client: any;
  private db: any;
  private collection: any;

  constructor(
    uri: string,
    private dbName: string = "agentium",
    private collectionName: string = "kv_store",
  ) {
    try {
      const { MongoClient } = _require("mongodb");
      this.client = new MongoClient(uri);
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("mongodb is required for MongoDBStorage. Install it: npm install mongodb");
      }
      throw e;
    }
  }

  async initialize(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection(this.collectionName);
    await this.collection.createIndex({ namespace: 1, key: 1 }, { unique: true });
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const doc = await this.collection.findOne({ namespace, key });
    if (!doc) return null;
    return doc.value as T;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.collection.updateOne({ namespace, key }, { $set: { value, updatedAt: new Date() } }, { upsert: true });
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.collection.deleteOne({ namespace, key });
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    const filter: Record<string, unknown> = { namespace };
    if (prefix) {
      filter.key = { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
    }

    const docs = await this.collection.find(filter).toArray();
    return docs.map((doc: any) => ({ key: doc.key as string, value: doc.value as T }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
