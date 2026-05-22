import { z } from "zod";
import type { ToolDef } from "../tools/types.js";
import { BM25Index } from "../vector/bm25.js";
import { type RankedItem, reciprocalRankFusion } from "../vector/rrf.js";
import type { VectorDocument, VectorSearchOptions, VectorSearchResult, VectorStore } from "../vector/types.js";

// ── Search mode ──────────────────────────────────────────────────────────

export type SearchMode = "vector" | "keyword" | "hybrid";

// ── Config ───────────────────────────────────────────────────────────────

export interface HybridSearchConfig {
  /** Weight for vector (semantic) results in RRF. Default 1.0. */
  vectorWeight?: number;
  /** Weight for keyword (BM25) results in RRF. Default 1.0. */
  keywordWeight?: number;
  /** RRF constant k. Higher = less rank-sensitive. Default 60. */
  rrfK?: number;
}

export interface KnowledgeBaseConfig {
  /** Display name used in tool description auto-generation. */
  name: string;
  /** The underlying vector store (any backend). */
  vectorStore: VectorStore;
  /** Collection/index name inside the vector store. */
  collection?: string;
  /**
   * Default search mode.
   * - `"vector"` — pure semantic (embedding) search (default, backward-compatible)
   * - `"keyword"` — pure BM25 keyword search
   * - `"hybrid"` — combines vector + keyword via Reciprocal Rank Fusion
   */
  searchMode?: SearchMode;
  /** Fine-tune hybrid search behavior. */
  hybridConfig?: HybridSearchConfig;
}

export interface KnowledgeBaseToolConfig {
  /** Tool name exposed to the LLM. Defaults to `search_<collection>`. */
  toolName?: string;
  /** Custom tool description. A sensible default is generated from the KB name. */
  description?: string;
  /** Number of results to return per search. Default 5. */
  topK?: number;
  /** Minimum similarity score to include. */
  minScore?: number;
  /** Metadata filter applied to every search. */
  filter?: Record<string, unknown>;
  /** Override the search mode for this tool. Inherits from KB config if not set. */
  searchMode?: SearchMode;
  /** Custom formatter for search results. Defaults to numbered list with scores. */
  formatResults?: (results: VectorSearchResult[]) => string;
}

// ── KnowledgeBase ────────────────────────────────────────────────────────

export class KnowledgeBase {
  readonly name: string;
  readonly collection: string;
  private store: VectorStore;
  private initialized = false;
  private bm25: BM25Index;
  private defaultSearchMode: SearchMode;
  private hybridConfig: Required<HybridSearchConfig>;

  constructor(config: KnowledgeBaseConfig) {
    this.name = config.name;
    this.store = config.vectorStore;
    this.collection = config.collection ?? config.name.toLowerCase().replace(/\s+/g, "_");
    this.defaultSearchMode = config.searchMode ?? "vector";
    this.hybridConfig = {
      vectorWeight: config.hybridConfig?.vectorWeight ?? 1.0,
      keywordWeight: config.hybridConfig?.keywordWeight ?? 1.0,
      rrfK: config.hybridConfig?.rrfK ?? 60,
    };
    this.bm25 = new BM25Index();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    this.initialized = true;
  }

  async add(doc: VectorDocument): Promise<void> {
    await this.ensureInit();
    await this.store.upsert(this.collection, doc);
    this.bm25.add({ id: doc.id, content: doc.content, metadata: doc.metadata });
  }

  async addDocuments(docs: VectorDocument[]): Promise<void> {
    await this.ensureInit();
    await this.store.upsertBatch(this.collection, docs);
    this.bm25.addBatch(docs.map((d) => ({ id: d.id, content: d.content, metadata: d.metadata })));
  }

  async search(
    query: string,
    options?: VectorSearchOptions & { searchMode?: SearchMode },
  ): Promise<VectorSearchResult[]> {
    await this.ensureInit();
    const mode = options?.searchMode ?? this.defaultSearchMode;

    switch (mode) {
      case "keyword":
        return this.keywordSearch(query, options);
      case "hybrid":
        return this.hybridSearch(query, options);
      default:
        return this.store.search(this.collection, query, options);
    }
  }

  async get(id: string): Promise<VectorDocument | null> {
    await this.ensureInit();
    return this.store.get(this.collection, id);
  }

  async delete(id: string): Promise<void> {
    await this.ensureInit();
    await this.store.delete(this.collection, id);
    this.bm25.remove(id);
  }

  async clear(): Promise<void> {
    await this.store.dropCollection(this.collection);
    this.bm25.clear();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Returns a ToolDef that an Agent can use to search this knowledge base.
   * Plug the result directly into `Agent({ tools: [kb.asTool()] })`.
   */
  asTool(config: KnowledgeBaseToolConfig = {}): ToolDef {
    const topK = config.topK ?? 5;
    const minScore = config.minScore;
    const filter = config.filter;
    const searchMode = config.searchMode;
    const toolName = config.toolName ?? `search_${this.collection}`;
    const description =
      config.description ??
      `Search the "${this.name}" knowledge base for relevant information. Use this before answering questions related to ${this.name}.`;

    const formatResults = config.formatResults ?? defaultFormatResults;

    return {
      name: toolName,
      description,
      parameters: z.object({
        query: z.string().describe("Search query to find relevant documents"),
      }),
      execute: async (args: Record<string, unknown>) => {
        const results = await this.search(args.query as string, {
          topK,
          minScore,
          filter,
          searchMode,
        });

        if (results.length === 0) {
          return "No relevant documents found in the knowledge base.";
        }

        return formatResults(results);
      },
    };
  }

  private keywordSearch(query: string, options?: VectorSearchOptions): VectorSearchResult[] {
    const results = this.bm25.search(query, {
      topK: options?.topK ?? 10,
      filter: options?.filter,
    });

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  private async hybridSearch(query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const topK = options?.topK ?? 10;
    const fetchK = topK * 2;

    const [vectorResults, keywordResults] = await Promise.all([
      this.store.search(this.collection, query, {
        ...options,
        topK: fetchK,
      }),
      Promise.resolve(
        this.bm25.search(query, {
          topK: fetchK,
          filter: options?.filter,
        }),
      ),
    ]);

    const vectorRanked: RankedItem[] = vectorResults.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));

    const keywordRanked: RankedItem[] = keywordResults.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));

    const fused = reciprocalRankFusion([vectorRanked, keywordRanked], {
      k: this.hybridConfig.rrfK,
      topK,
      weights: [this.hybridConfig.vectorWeight, this.hybridConfig.keywordWeight],
    });

    return fused.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      metadata: r.metadata,
    }));
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

function defaultFormatResults(results: VectorSearchResult[]): string {
  const lines = results.map((r, i) => {
    const meta = r.metadata
      ? Object.entries(r.metadata)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "";
    const metaStr = meta ? ` | ${meta}` : "";
    return `[${i + 1}] (score: ${r.score.toFixed(3)}${metaStr})\n${r.content}`;
  });
  return `Found ${results.length} relevant document(s):\n\n${lines.join("\n\n")}`;
}
