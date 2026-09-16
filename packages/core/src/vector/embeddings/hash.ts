import type { EmbeddingProvider } from "../types.js";

/**
 * Tiny local embedder (no API key). Good enough for tests and Agent.deep()
 * defaults. Swap in OpenAI/Google embeddings for production search quality.
 */
export class HashEmbedding implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const token of tokens) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[Math.abs(h) % this.dimensions] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0)) || 1;
    return vec.map((n) => n / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
