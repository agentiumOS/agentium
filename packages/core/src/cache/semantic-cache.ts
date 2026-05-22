import type { RunOutput } from "../agent/types.js";
import type { EmbeddingProvider, VectorStore } from "../vector/types.js";
import type { CacheHit, SemanticCacheConfig } from "./types.js";

export class SemanticCache {
  private vectorStore: VectorStore;
  private embedding: EmbeddingProvider;
  private threshold: number;
  private ttl: number | undefined;
  private collection: string;
  private scope: "global" | "agent" | "session";
  private maxEntries: number | undefined;
  private entryCount = 0;
  private initialized = false;

  constructor(config: SemanticCacheConfig) {
    this.vectorStore = config.vectorStore;
    this.embedding = config.embedding;
    this.threshold = config.similarityThreshold ?? 0.92;
    this.ttl = config.ttl;
    this.collection = config.collection ?? "semantic_cache";
    this.scope = config.scope ?? "global";
    this.maxEntries = config.maxEntries;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.vectorStore.initialize();
  }

  private getCollectionName(agentName?: string, sessionId?: string): string {
    if (this.scope === "session" && sessionId) {
      return `${this.collection}_${sessionId}`;
    }
    if (this.scope === "agent" && agentName) {
      return `${this.collection}_${agentName}`;
    }
    return this.collection;
  }

  async lookup(input: string, agentName?: string, sessionId?: string): Promise<CacheHit | null> {
    await this.ensureInit();

    const col = this.getCollectionName(agentName, sessionId);
    const queryVec = await this.embedding.embed(input);

    const results = await this.vectorStore.search(col, queryVec, {
      topK: 1,
      minScore: this.threshold,
    });

    if (results.length === 0) return null;

    const best = results[0];
    const metadata = best.metadata as Record<string, unknown> | undefined;
    if (!metadata?.outputJson) return null;

    const cachedAt = (metadata.cachedAt as number) ?? 0;
    if (this.ttl && Date.now() - cachedAt > this.ttl) {
      this.vectorStore.delete(col, best.id).catch(() => {});
      return null;
    }

    try {
      const output: RunOutput = JSON.parse(metadata.outputJson as string);
      return {
        id: best.id,
        output,
        score: best.score,
        cachedAt,
      };
    } catch {
      return null;
    }
  }

  async store(input: string, output: RunOutput, agentName?: string, sessionId?: string): Promise<void> {
    await this.ensureInit();

    if (this.maxEntries && this.entryCount >= this.maxEntries) {
      return;
    }

    const col = this.getCollectionName(agentName, sessionId);
    const embedding = await this.embedding.embed(input);
    const id = `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await this.vectorStore.upsert(col, {
      id,
      content: input,
      embedding,
      metadata: {
        outputJson: JSON.stringify(output),
        agentName,
        sessionId,
        cachedAt: Date.now(),
      },
    });
    this.entryCount++;
  }

  async invalidate(id: string, agentName?: string, sessionId?: string): Promise<void> {
    await this.ensureInit();
    const col = this.getCollectionName(agentName, sessionId);
    await this.vectorStore.delete(col, id);
  }

  async clear(agentName?: string, sessionId?: string): Promise<void> {
    await this.ensureInit();
    const col = this.getCollectionName(agentName, sessionId);
    await this.vectorStore.dropCollection(col);
  }
}
