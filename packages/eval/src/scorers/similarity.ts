import type { EmbeddingProvider, RunOutput } from "@agentium/core";
import type { Scorer, ScorerResult } from "../types.js";

export function semanticSimilarity(config: {
  expected: string;
  embedding: EmbeddingProvider;
  threshold?: number;
}): Scorer {
  const threshold = config.threshold ?? 0.8;

  return {
    name: "similarity",
    async score(_input: string, output: RunOutput): Promise<ScorerResult> {
      const vecs = await config.embedding.embedBatch([output.text, config.expected]);
      if (!vecs || vecs.length < 2 || !vecs[0] || !vecs[1]) {
        return { score: 0, pass: false, reason: "Embedding failed: insufficient vectors returned" };
      }
      const [outputVec, expectedVec] = vecs;
      if (outputVec.length !== expectedVec.length) {
        return {
          score: 0,
          pass: false,
          reason: `Vector dimension mismatch: ${outputVec.length} vs ${expectedVec.length}`,
        };
      }

      const sim = cosineSimilarity(outputVec, expectedVec);
      const pass = sim >= threshold;

      return {
        score: sim,
        pass,
        reason: pass ? undefined : `Similarity ${sim.toFixed(3)} < threshold ${threshold}`,
      };
    },
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
