import type { RunOutput } from "../agent/types.js";
import type { EmbeddingProvider, VectorStore } from "../vector/types.js";

export interface SemanticCacheConfig {
  vectorStore: VectorStore;
  embedding: EmbeddingProvider;
  similarityThreshold?: number;
  ttl?: number;
  collection?: string;
  maxEntries?: number;
  scope?: "global" | "agent" | "session";
}

export interface CacheHit {
  id: string;
  output: RunOutput;
  score: number;
  cachedAt: number;
}

export interface CacheDocument {
  input: string;
  outputText: string;
  outputJson: string;
  agentName?: string;
  sessionId?: string;
  cachedAt: number;
}
