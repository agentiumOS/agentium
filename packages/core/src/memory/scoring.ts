export interface ScoredMemory {
  content: string;
  score: number;
  source: string;
}

export interface ScoringWeights {
  semantic: number;
  recency: number;
  importance: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  semantic: 0.4,
  recency: 0.3,
  importance: 0.3,
};

const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Exponential decay based on age. Returns a value between 0 and 1.
 * Half-life determines how quickly older items lose relevance.
 */
export function recencyDecay(createdAt: Date, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/**
 * Compute a composite score blending semantic similarity, recency, and importance.
 * All inputs are normalized to 0-1. Returns a value between 0 and 1.
 */
export function computeCompositeScore(opts: {
  semanticSimilarity?: number;
  createdAt: Date;
  importance?: number;
  weights?: Partial<ScoringWeights>;
  halfLifeDays?: number;
}): number {
  const w: ScoringWeights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const total = w.semantic + w.recency + w.importance;
  const ns = w.semantic / total;
  const nr = w.recency / total;
  const ni = w.importance / total;

  const semantic = Math.max(0, Math.min(1, opts.semanticSimilarity ?? 0.5));
  const recency = recencyDecay(opts.createdAt, opts.halfLifeDays);
  const importance = Math.max(0, Math.min(1, opts.importance ?? 0.5));

  return ns * semantic + nr * recency + ni * importance;
}
