import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryVectorStore } from "../in-memory.js";

describe("InMemoryVectorStore", () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  const doc1 = { id: "1", content: "hello", embedding: [1, 0, 0], metadata: { tag: "greeting" } };
  const doc2 = { id: "2", content: "goodbye", embedding: [0, 1, 0], metadata: { tag: "farewell" } };
  const doc3 = { id: "3", content: "hi there", embedding: [0.9, 0.1, 0], metadata: { tag: "greeting" } };

  describe("initialize()", () => {
    it("does not throw", async () => {
      await expect(store.initialize()).resolves.toBeUndefined();
    });
  });

  describe("upsert() and search() round-trip", () => {
    it("upserts a document and finds it via search", async () => {
      await store.upsert("col", doc1);
      const results = await store.search("col", [1, 0, 0]);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("1");
      expect(results[0].content).toBe("hello");
      expect(results[0].score).toBeCloseTo(1.0);
    });

    it("upserts overwrites existing document", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", { ...doc1, content: "hello updated" });
      const doc = await store.get("col", "1");
      expect(doc!.content).toBe("hello updated");
    });
  });

  describe("search() result ordering", () => {
    it("returns results sorted by score, highest first", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.upsert("col", doc3);

      const results = await store.search("col", [1, 0, 0]);
      expect(results[0].id).toBe("1"); // exact match → score 1.0
      expect(results[1].id).toBe("3"); // close match → high score
      expect(results[2].id).toBe("2"); // orthogonal → score 0.0
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });
  });

  describe("search() with topK", () => {
    it("limits the number of results", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.upsert("col", doc3);

      const results = await store.search("col", [1, 0, 0], { topK: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe("1");
      expect(results[1].id).toBe("3");
    });

    it("returns all if topK exceeds available documents", async () => {
      await store.upsert("col", doc1);
      const results = await store.search("col", [1, 0, 0], { topK: 100 });
      expect(results).toHaveLength(1);
    });
  });

  describe("search() with metadata filter", () => {
    it("filters by metadata tag", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.upsert("col", doc3);

      const results = await store.search("col", [1, 0, 0], {
        filter: { tag: "greeting" },
      });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.metadata?.tag === "greeting")).toBe(true);
    });

    it("returns empty when no documents match the filter", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);

      const results = await store.search("col", [1, 0, 0], {
        filter: { tag: "nonexistent" },
      });
      expect(results).toEqual([]);
    });
  });

  describe("search() with minScore", () => {
    it("excludes results below the minimum score", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.upsert("col", doc3);

      const results = await store.search("col", [1, 0, 0], { minScore: 0.5 });
      expect(results.every((r) => r.score >= 0.5)).toBe(true);
      expect(results.some((r) => r.id === "2")).toBe(false); // orthogonal vector, score ~0
    });
  });

  describe("search() on empty collection", () => {
    it("returns empty array", async () => {
      const results = await store.search("empty", [1, 0, 0]);
      expect(results).toEqual([]);
    });
  });

  describe("delete()", () => {
    it("removes a document by id", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.delete("col", "1");

      expect(await store.get("col", "1")).toBeNull();
      expect(await store.get("col", "2")).not.toBeNull();
    });

    it("is a no-op for nonexistent id", async () => {
      await expect(store.delete("col", "ghost")).resolves.toBeUndefined();
    });

    it("removes document from search results", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.delete("col", "1");

      const results = await store.search("col", [1, 0, 0]);
      expect(results.every((r) => r.id !== "1")).toBe(true);
    });
  });

  describe("get()", () => {
    it("retrieves a document by id", async () => {
      await store.upsert("col", doc1);
      const doc = await store.get("col", "1");
      expect(doc).toEqual({ id: "1", content: "hello", metadata: { tag: "greeting" } });
    });

    it("returns null for missing documents", async () => {
      expect(await store.get("col", "missing")).toBeNull();
    });
  });

  describe("dropCollection()", () => {
    it("removes all documents in a collection", async () => {
      await store.upsert("col", doc1);
      await store.upsert("col", doc2);
      await store.dropCollection("col");

      const results = await store.search("col", [1, 0, 0]);
      expect(results).toEqual([]);
      expect(await store.get("col", "1")).toBeNull();
    });

    it("does not affect other collections", async () => {
      await store.upsert("col1", doc1);
      await store.upsert("col2", doc2);
      await store.dropCollection("col1");

      expect(await store.get("col2", "2")).not.toBeNull();
    });
  });

  describe("cosineSimilarity dimension mismatch", () => {
    it("throws on dimension mismatch", async () => {
      await store.upsert("col", { id: "1", content: "a", embedding: [1, 0, 0] });

      await expect(store.search("col", [1, 0])).rejects.toThrow("Vector dimension mismatch");
    });
  });

  describe("upsertBatch()", () => {
    it("inserts multiple documents", async () => {
      await store.upsertBatch("col", [doc1, doc2, doc3]);

      expect(await store.get("col", "1")).not.toBeNull();
      expect(await store.get("col", "2")).not.toBeNull();
      expect(await store.get("col", "3")).not.toBeNull();
    });

    it("documents are searchable after batch upsert", async () => {
      await store.upsertBatch("col", [doc1, doc2, doc3]);
      const results = await store.search("col", [1, 0, 0]);
      expect(results).toHaveLength(3);
    });
  });

  describe("close()", () => {
    it("clears all collections", async () => {
      await store.upsert("col1", doc1);
      await store.upsert("col2", doc2);
      await store.close();

      expect(await store.get("col1", "1")).toBeNull();
      expect(await store.get("col2", "2")).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("zero vectors result in 0 similarity", async () => {
      await store.upsert("col", { id: "zero", content: "zero", embedding: [0, 0, 0] });
      const results = await store.search("col", [1, 0, 0]);
      expect(results[0].score).toBe(0);
    });

    it("negative embeddings compute correctly", async () => {
      await store.upsert("col", { id: "neg", content: "neg", embedding: [-1, 0, 0] });
      const results = await store.search("col", [1, 0, 0]);
      expect(results[0].score).toBeCloseTo(-1.0);
    });
  });
});
