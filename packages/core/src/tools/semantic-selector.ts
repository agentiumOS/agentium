import type { Reranker } from "../rerank/types.js";
import type { EmbeddingProvider } from "../vector/types.js";
import type { ToolDef } from "./types.js";

export interface SemanticToolSelectorConfig {
  /** Required: embeddings provider used to embed tool descriptions and queries. */
  embedder: EmbeddingProvider;
  /** Optional reranker for the top-K shortlist. */
  reranker?: Reranker;
  /** Default top-K. */
  topK?: number;
  /** Multiplier on top-K when a reranker is configured. */
  rerankMultiplier?: number;
}

interface ToolEmbedding {
  tool: ToolDef;
  vector: number[];
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Picks the top-K most semantically relevant tools for a given query.
 *
 * Designed for agents that have 30+ tools where stuffing all tool definitions
 * into the prompt would blow the context window. Embeds each tool's `name` +
 * `description` once on init, then runs a cheap cosine top-K (+ optional rerank)
 * against the user input on each turn.
 *
 * @example
 * ```ts
 * const selector = new SemanticToolSelector({ embedder: new OpenAIEmbedding() });
 * await selector.indexTools(allTools);
 * const shortlist = await selector.select(userInput, { topK: 10 });
 * agent.setTools(shortlist);
 * ```
 */
export class SemanticToolSelector {
  private embedder: EmbeddingProvider;
  private reranker?: Reranker;
  private defaultTopK: number;
  private rerankMultiplier: number;
  private embeddings: ToolEmbedding[] = [];

  constructor(config: SemanticToolSelectorConfig) {
    this.embedder = config.embedder;
    this.reranker = config.reranker;
    this.defaultTopK = config.topK ?? 10;
    this.rerankMultiplier = config.rerankMultiplier ?? 3;
  }

  /** Pre-compute embeddings for every tool. Call once or when the tool set changes. */
  async indexTools(tools: ToolDef[]): Promise<void> {
    const descriptions = tools.map((t) => `${t.name}: ${t.description}`);
    const vectors = await this.embedder.embedBatch(descriptions);
    this.embeddings = tools.map((tool, i) => ({ tool, vector: vectors[i] }));
  }

  /**
   * Return the top-K most relevant tools for `query`.
   * If a reranker is configured, fetches `topK * rerankMultiplier` candidates and reranks.
   */
  async select(query: string, options: { topK?: number } = {}): Promise<ToolDef[]> {
    if (this.embeddings.length === 0) return [];
    const topK = options.topK ?? this.defaultTopK;
    const fetchK = this.reranker ? Math.max(topK, topK * this.rerankMultiplier) : topK;

    const queryVec = await this.embedder.embed(query);
    const scored = this.embeddings
      .map((e) => ({ tool: e.tool, score: cosine(queryVec, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, fetchK);

    if (!this.reranker) return scored.map((s) => s.tool);

    const reranked = await this.reranker.rerank(
      query,
      scored.map((s) => ({ id: s.tool.name, content: `${s.tool.name}: ${s.tool.description}` })),
      { topK },
    );

    // Map back to ToolDef preserving rerank order.
    const byName = new Map(scored.map((s) => [s.tool.name, s.tool]));
    return reranked.map((r) => byName.get(r.id ?? "")).filter((t): t is ToolDef => !!t);
  }

  /** Number of tools currently indexed. */
  get size(): number {
    return this.embeddings.length;
  }
}
