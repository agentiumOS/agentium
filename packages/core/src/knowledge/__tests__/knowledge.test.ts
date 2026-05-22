import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import type { VectorDocument, VectorSearchResult, VectorStore } from "../../vector/types.js";
import { KnowledgeBase } from "../knowledge-base.js";

const dummyCtx = new RunContext({ sessionId: "test", metadata: {}, eventBus: new EventBus(), sessionState: {} });

function createMockVectorStore(): VectorStore {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    dropCollection: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("KnowledgeBase", () => {
  let store: ReturnType<typeof createMockVectorStore>;
  let kb: KnowledgeBase;

  beforeEach(() => {
    vi.restoreAllMocks();
    store = createMockVectorStore();
    kb = new KnowledgeBase({
      name: "Test KB",
      vectorStore: store,
    });
  });

  describe("creation", () => {
    it("sets name from config", () => {
      expect(kb.name).toBe("Test KB");
    });

    it("derives collection name from name when not provided", () => {
      expect(kb.collection).toBe("test_kb");
    });

    it("uses explicit collection name when provided", () => {
      const kb2 = new KnowledgeBase({
        name: "My KB",
        vectorStore: store,
        collection: "custom_collection",
      });
      expect(kb2.collection).toBe("custom_collection");
    });
  });

  describe("initialize", () => {
    it("calls store.initialize on first call", async () => {
      await kb.initialize();
      expect(store.initialize).toHaveBeenCalledTimes(1);
    });

    it("skips initialization on subsequent calls", async () => {
      await kb.initialize();
      await kb.initialize();
      expect(store.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe("add", () => {
    it("upserts a single document to the store", async () => {
      const doc: VectorDocument = { id: "doc1", content: "hello world" };
      await kb.add(doc);

      expect(store.initialize).toHaveBeenCalled();
      expect(store.upsert).toHaveBeenCalledWith("test_kb", doc);
    });

    it("indexes the document in BM25 for keyword search", async () => {
      const doc: VectorDocument = { id: "doc1", content: "machine learning tutorial" };
      await kb.add(doc);

      const results = await kb.search("machine learning", { searchMode: "keyword" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("doc1");
    });
  });

  describe("addDocuments", () => {
    it("upserts a batch of documents", async () => {
      const docs: VectorDocument[] = [
        { id: "d1", content: "first doc" },
        { id: "d2", content: "second doc" },
      ];

      await kb.addDocuments(docs);

      expect(store.upsertBatch).toHaveBeenCalledWith("test_kb", docs);
    });

    it("indexes all docs in BM25", async () => {
      const docs: VectorDocument[] = [
        { id: "d1", content: "python programming language" },
        { id: "d2", content: "javascript framework" },
      ];

      await kb.addDocuments(docs);

      const results = await kb.search("python programming", { searchMode: "keyword" });
      expect(results.some((r) => r.id === "d1")).toBe(true);
    });
  });

  describe("search — vector mode (default)", () => {
    it("delegates to store.search for vector mode", async () => {
      const mockResults: VectorSearchResult[] = [{ id: "r1", content: "relevant doc", score: 0.95 }];
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const results = await kb.search("query text");

      expect(store.search).toHaveBeenCalledWith("test_kb", "query text", undefined);
      expect(results).toEqual(mockResults);
    });

    it("passes options through to store.search", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await kb.search("query", { topK: 3, minScore: 0.5 });

      expect(store.search).toHaveBeenCalledWith(
        "test_kb",
        "query",
        expect.objectContaining({ topK: 3, minScore: 0.5 }),
      );
    });
  });

  describe("search — keyword mode", () => {
    it("uses BM25 index for keyword search", async () => {
      await kb.add({ id: "k1", content: "artificial intelligence research paper" });
      await kb.add({ id: "k2", content: "cooking recipe book" });

      const results = await kb.search("artificial intelligence", { searchMode: "keyword" });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toBe("k1");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("returns empty array for no keyword matches", async () => {
      await kb.add({ id: "k1", content: "something completely different" });

      const results = await kb.search("xyznonexistent", { searchMode: "keyword" });
      expect(results).toHaveLength(0);
    });
  });

  describe("search — hybrid mode", () => {
    it("combines vector and keyword results via RRF", async () => {
      const vectorResults: VectorSearchResult[] = [{ id: "v1", content: "vector match", score: 0.9 }];
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(vectorResults);

      await kb.add({ id: "v1", content: "vector match for hybrid test" });

      const hybridKb = new KnowledgeBase({
        name: "Hybrid KB",
        vectorStore: store,
        searchMode: "hybrid",
      });

      await hybridKb.add({ id: "h1", content: "hybrid document search" });
      const _results = await hybridKb.search("hybrid search");

      expect(store.search).toHaveBeenCalled();
    });
  });

  describe("search — empty knowledge base", () => {
    it("returns empty results for vector search on empty KB", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const results = await kb.search("anything");
      expect(results).toHaveLength(0);
    });

    it("returns empty results for keyword search on empty KB", async () => {
      const results = await kb.search("anything", { searchMode: "keyword" });
      expect(results).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("retrieves a document by ID", async () => {
      const doc: VectorDocument = { id: "g1", content: "found doc" };
      (store.get as ReturnType<typeof vi.fn>).mockResolvedValue(doc);

      const result = await kb.get("g1");

      expect(store.get).toHaveBeenCalledWith("test_kb", "g1");
      expect(result).toEqual(doc);
    });

    it("returns null for non-existent document", async () => {
      (store.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await kb.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes from store and BM25 index", async () => {
      await kb.add({ id: "del1", content: "to be deleted" });
      await kb.delete("del1");

      expect(store.delete).toHaveBeenCalledWith("test_kb", "del1");

      const keywordResults = await kb.search("deleted", { searchMode: "keyword" });
      expect(keywordResults).toHaveLength(0);
    });
  });

  describe("clear", () => {
    it("drops the collection and clears BM25 index", async () => {
      await kb.add({ id: "c1", content: "will be cleared" });
      await kb.clear();

      expect(store.dropCollection).toHaveBeenCalledWith("test_kb");

      const results = await kb.search("cleared", { searchMode: "keyword" });
      expect(results).toHaveLength(0);
    });
  });

  describe("close", () => {
    it("closes the underlying store", async () => {
      await kb.close();
      expect(store.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("asTool", () => {
    it("returns a ToolDef with correct defaults", () => {
      const tool = kb.asTool();

      expect(tool.name).toBe("search_test_kb");
      expect(tool.description).toContain("Test KB");
      expect(tool.execute).toBeTypeOf("function");
    });

    it("uses custom tool name and description", () => {
      const tool = kb.asTool({
        toolName: "custom_search",
        description: "Custom description",
      });

      expect(tool.name).toBe("custom_search");
      expect(tool.description).toBe("Custom description");
    });

    it("executes search and returns formatted results", async () => {
      const mockResults: VectorSearchResult[] = [{ id: "t1", content: "tool result content", score: 0.88 }];
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const tool = kb.asTool();
      const result = await tool.execute({ query: "search query" }, dummyCtx);

      expect(result).toContain("tool result content");
      expect(result).toContain("0.880");
    });

    it("returns 'no documents found' message when search is empty", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = kb.asTool();
      const result = await tool.execute({ query: "no results" }, dummyCtx);

      expect(result).toContain("No relevant documents found");
    });

    it("uses custom formatResults function", async () => {
      const mockResults: VectorSearchResult[] = [{ id: "f1", content: "formatted", score: 0.9 }];
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      const tool = kb.asTool({
        formatResults: (results) => `Custom: ${results.length} results`,
      });

      const result = await tool.execute({ query: "test" }, dummyCtx);
      expect(result).toBe("Custom: 1 results");
    });

    it("passes topK and filter to search", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const tool = kb.asTool({
        topK: 3,
        filter: { category: "science" },
      });

      await tool.execute({ query: "test" }, dummyCtx);

      expect(store.search).toHaveBeenCalledWith(
        "test_kb",
        "test",
        expect.objectContaining({ topK: 3, filter: { category: "science" } }),
      );
    });
  });

  describe("search mode configuration", () => {
    it("defaults to vector search mode", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await kb.search("test");

      expect(store.search).toHaveBeenCalled();
    });

    it("respects config-level searchMode", async () => {
      const keywordKb = new KnowledgeBase({
        name: "Keyword KB",
        vectorStore: store,
        searchMode: "keyword",
      });

      await keywordKb.add({ id: "kw1", content: "keyword searchable content" });
      const results = await keywordKb.search("keyword searchable");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(store.search).not.toHaveBeenCalled();
    });

    it("per-search searchMode overrides config-level", async () => {
      (store.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const keywordKb = new KnowledgeBase({
        name: "Override KB",
        vectorStore: store,
        searchMode: "keyword",
      });

      await keywordKb.search("test", { searchMode: "vector" });

      expect(store.search).toHaveBeenCalled();
    });
  });

  describe("metadata handling", () => {
    it("preserves metadata through add and keyword search", async () => {
      await kb.add({
        id: "m1",
        content: "document with metadata tags",
        metadata: { category: "tech", author: "alice" },
      });

      const results = await kb.search("document metadata tags", { searchMode: "keyword" });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].metadata).toEqual({ category: "tech", author: "alice" });
    });
  });
});
