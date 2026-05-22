/**
 * Reciprocal Rank Fusion (RRF) — merges ranked result lists from different
 * retrieval methods into a single fused ranking.
 *
 * RRF score for document d = sum over all lists L of: 1 / (k + rank_L(d))
 * where k is a constant (default 60) that mitigates the impact of high
 * rankings by outlier systems.
 *
 * Reference: Cormack, Clarke & Buettcher (2009)
 */

export interface RankedItem {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RRFOptions {
  /** Fusion constant. Higher values dampen the effect of rank differences. Default 60. */
  k?: number;
  /** Maximum results to return. */
  topK?: number;
  /** Minimum fused score to include. */
  minScore?: number;
  /** Weight per ranked list. Defaults to equal weighting (1.0 each). */
  weights?: number[];
}

export function reciprocalRankFusion(rankedLists: RankedItem[][], options?: RRFOptions): RankedItem[] {
  const k = options?.k ?? 60;
  const topK = options?.topK ?? 10;
  const weights = options?.weights ?? rankedLists.map(() => 1.0);

  const fusedScores = new Map<string, { score: number; item: RankedItem }>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    const weight = weights[listIdx] ?? 1.0;

    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfScore = weight / (k + rank + 1);

      const existing = fusedScores.get(item.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        fusedScores.set(item.id, {
          score: rrfScore,
          item: { ...item },
        });
      }
    }
  }

  const results = Array.from(fusedScores.values()).map(({ score, item }) => ({
    ...item,
    score,
  }));

  results.sort((a, b) => b.score - a.score);

  if (options?.minScore != null) {
    const min = options.minScore;
    return results.filter((r) => r.score >= min).slice(0, topK);
  }

  return results.slice(0, topK);
}
