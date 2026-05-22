/**
 * Lightweight BM25 (Okapi BM25) implementation for keyword search.
 * Maintains an in-memory inverted index for fast full-text scoring.
 */

export interface BM25Document {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BM25Result {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

interface DocEntry {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  termFreqs: Map<string, number>;
  length: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export class BM25Index {
  private docs = new Map<string, DocEntry>();
  private docFreqs = new Map<string, number>();
  private avgDocLength = 0;

  /** BM25 free parameter: term frequency saturation. */
  private k1: number;
  /** BM25 free parameter: document length normalization. */
  private b: number;

  constructor(opts?: { k1?: number; b?: number }) {
    this.k1 = opts?.k1 ?? 1.5;
    this.b = opts?.b ?? 0.75;
  }

  get size(): number {
    return this.docs.size;
  }

  add(doc: BM25Document): void {
    this.remove(doc.id);

    const tokens = tokenize(doc.content);
    const termFreqs = new Map<string, number>();
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
    }

    const entry: DocEntry = {
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      termFreqs,
      length: tokens.length,
    };
    this.docs.set(doc.id, entry);

    for (const term of termFreqs.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
    }

    this.recomputeAvgLength();
  }

  addBatch(docs: BM25Document[]): void {
    for (const doc of docs) {
      this.add(doc);
    }
  }

  remove(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;

    for (const term of existing.termFreqs.keys()) {
      const count = this.docFreqs.get(term) ?? 1;
      if (count <= 1) {
        this.docFreqs.delete(term);
      } else {
        this.docFreqs.set(term, count - 1);
      }
    }

    this.docs.delete(id);
    this.recomputeAvgLength();
  }

  clear(): void {
    this.docs.clear();
    this.docFreqs.clear();
    this.avgDocLength = 0;
  }

  search(query: string, opts?: { topK?: number; minScore?: number; filter?: Record<string, unknown> }): BM25Result[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const N = this.docs.size;
    if (N === 0) return [];

    const topK = opts?.topK ?? 10;
    const results: BM25Result[] = [];

    for (const doc of this.docs.values()) {
      if (opts?.filter) {
        let match = true;
        for (const [k, v] of Object.entries(opts.filter)) {
          if (doc.metadata?.[k] !== v) {
            match = false;
            break;
          }
        }
        if (!match) continue;
      }

      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(term) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (doc.length / this.avgDocLength));
        score += idf * (numerator / denominator);
      }

      if (score > 0 && (opts?.minScore == null || score >= opts.minScore)) {
        results.push({
          id: doc.id,
          content: doc.content,
          score,
          metadata: doc.metadata,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private recomputeAvgLength(): void {
    if (this.docs.size === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.length;
    }
    this.avgDocLength = total / this.docs.size;
  }
}
