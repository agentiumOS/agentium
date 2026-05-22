import { beforeEach, describe, expect, it } from "vitest";
import { BM25Index } from "../bm25.js";

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  describe("basic search", () => {
    it("returns relevant documents for a query", () => {
      index.add({ id: "1", content: "The quick brown fox jumps over the lazy dog" });
      index.add({ id: "2", content: "Machine learning algorithms for natural language processing" });
      index.add({ id: "3", content: "The brown fox is quick and agile" });

      const results = index.search("quick brown fox");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.id === "1")).toBe(true);
      expect(results.some((r) => r.id === "3")).toBe(true);
    });

    it("does not return irrelevant documents (no term overlap)", () => {
      index.add({ id: "1", content: "JavaScript TypeScript programming" });
      index.add({ id: "2", content: "Cooking recipes Italian pasta" });

      const results = index.search("JavaScript programming");
      expect(results.every((r) => r.id !== "2")).toBe(true);
    });
  });

  describe("empty corpus", () => {
    it("returns empty results when no documents are indexed", () => {
      const results = index.search("hello world");
      expect(results).toEqual([]);
    });
  });

  describe("empty/stop-word-only query", () => {
    it("returns empty for a query of only stop words", () => {
      index.add({ id: "1", content: "important data here" });
      const results = index.search("the and is");
      expect(results).toEqual([]);
    });

    it("returns empty for an empty query", () => {
      index.add({ id: "1", content: "some content" });
      const results = index.search("");
      expect(results).toEqual([]);
    });
  });

  describe("score ordering", () => {
    it("ranks documents with more query term matches higher", () => {
      index.add({ id: "1", content: "rust programming language systems" });
      index.add({ id: "2", content: "rust programming language systems rust memory safety rust" });
      index.add({ id: "3", content: "python programming language" });

      const results = index.search("rust programming");
      expect(results.length).toBeGreaterThanOrEqual(2);

      const rustIds = results.filter((r) => r.id === "1" || r.id === "2");
      expect(rustIds.length).toBe(2);

      const scores = results.map((r) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
    });
  });

  describe("Unicode text handling", () => {
    it("handles space-separated CJK tokens", () => {
      index.add({ id: "1", content: "机器 学习 人工 智能" });
      index.add({ id: "2", content: "自然 语言 处理 技术" });

      const results = index.search("机器 学习");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1");
    });

    it("handles accented Latin characters", () => {
      index.add({ id: "1", content: "café résumé naïve" });
      const results = index.search("café");
      expect(results.length).toBeGreaterThan(0);
    });

    it("handles mixed Latin and CJK text", () => {
      index.add({ id: "1", content: "TypeScript 编程 语言 very powerful" });
      index.add({ id: "2", content: "Python programming language" });

      const results = index.search("TypeScript 编程");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1");
    });

    it("does not crash on unsegmented CJK text", () => {
      index.add({ id: "1", content: "机器学习是人工智能的一个分支" });
      expect(() => index.search("机器学习")).not.toThrow();
    });

    it("matches when full unsegmented CJK token is the same in doc and query", () => {
      index.add({ id: "1", content: "プログラミング テスト 開発" });
      const results = index.search("プログラミング");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("1");
    });
  });

  describe("stop words filtering", () => {
    it("filters common English stop words", () => {
      index.add({ id: "1", content: "machine learning algorithms" });

      const results1 = index.search("the machine learning");
      const results2 = index.search("machine learning");
      expect(results1.length).toBe(results2.length);
      if (results1.length > 0 && results2.length > 0) {
        expect(results1[0].score).toBeCloseTo(results2[0].score);
      }
    });

    it("query of only stop words returns empty", () => {
      index.add({ id: "1", content: "hello world" });
      const results = index.search("the is a an");
      expect(results).toEqual([]);
    });
  });

  describe("topK parameter", () => {
    it("limits the number of results", () => {
      for (let i = 0; i < 20; i++) {
        index.add({ id: `${i}`, content: `document about testing number ${i} testing` });
      }

      const results = index.search("testing", { topK: 5 });
      expect(results).toHaveLength(5);
    });

    it("returns all if topK exceeds corpus size", () => {
      index.add({ id: "1", content: "alpha beta" });
      index.add({ id: "2", content: "alpha gamma" });

      const results = index.search("alpha", { topK: 100 });
      expect(results).toHaveLength(2);
    });

    it("defaults to 10 results", () => {
      for (let i = 0; i < 15; i++) {
        index.add({ id: `${i}`, content: `keyword repeated keyword keyword doc ${i}` });
      }

      const results = index.search("keyword");
      expect(results.length).toBeLessThanOrEqual(10);
    });
  });

  describe("minScore parameter", () => {
    it("filters out low-scoring results", () => {
      index.add({ id: "1", content: "exact match term term term" });
      index.add({ id: "2", content: "something completely different unrelated content" });

      const results = index.search("exact match term", { minScore: 0.5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.score >= 0.5)).toBe(true);
    });
  });

  describe("filter parameter", () => {
    it("filters by metadata", () => {
      index.add({ id: "1", content: "TypeScript programming", metadata: { lang: "ts" } });
      index.add({ id: "2", content: "Python programming", metadata: { lang: "py" } });

      const results = index.search("programming", { filter: { lang: "ts" } });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("1");
    });
  });

  describe("add(), remove(), clear()", () => {
    it("remove() decreases document count", () => {
      index.add({ id: "1", content: "test document" });
      index.add({ id: "2", content: "test document" });
      expect(index.size).toBe(2);

      index.remove("1");
      expect(index.size).toBe(1);
    });

    it("remove() makes document unsearchable", () => {
      index.add({ id: "1", content: "unique special keyword" });
      index.remove("1");

      const results = index.search("unique special keyword");
      expect(results).toEqual([]);
    });

    it("remove() is a no-op for nonexistent id", () => {
      index.add({ id: "1", content: "hello" });
      index.remove("nonexistent");
      expect(index.size).toBe(1);
    });

    it("add() with duplicate id replaces existing document", () => {
      index.add({ id: "1", content: "original content" });
      index.add({ id: "1", content: "updated content" });
      expect(index.size).toBe(1);

      const results = index.search("updated");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("updated content");
    });

    it("clear() removes all documents", () => {
      index.add({ id: "1", content: "hello world" });
      index.add({ id: "2", content: "world peace" });
      index.clear();

      expect(index.size).toBe(0);
      expect(index.search("hello")).toEqual([]);
    });
  });

  describe("addBatch()", () => {
    it("inserts multiple documents at once", () => {
      index.addBatch([
        { id: "1", content: "alpha beta" },
        { id: "2", content: "gamma delta" },
        { id: "3", content: "alpha gamma" },
      ]);

      expect(index.size).toBe(3);
      const results = index.search("alpha");
      expect(results).toHaveLength(2);
    });
  });

  describe("BM25 parameters", () => {
    it("accepts custom k1 and b parameters", () => {
      const customIndex = new BM25Index({ k1: 2.0, b: 0.5 });
      customIndex.add({ id: "1", content: "test document content" });

      const results = customIndex.search("test");
      expect(results.length).toBeGreaterThan(0);
    });

    it("different k1/b produce different scores", () => {
      const idx1 = new BM25Index({ k1: 1.2, b: 0.75 });
      const idx2 = new BM25Index({ k1: 2.0, b: 0.25 });
      const docs = [
        { id: "1", content: "search engine optimization techniques and methods" },
        { id: "2", content: "search search search dense keyword document" },
      ];
      idx1.addBatch(docs);
      idx2.addBatch(docs);

      const r1 = idx1.search("search");
      const r2 = idx2.search("search");
      expect(r1[0].score).not.toBeCloseTo(r2[0].score);
    });
  });
});
