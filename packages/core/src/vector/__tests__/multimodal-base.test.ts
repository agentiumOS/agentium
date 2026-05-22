import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentPart } from "../../models/types.js";
import { InMemoryVectorStore } from "../in-memory.js";
import type { EmbeddingProvider } from "../types.js";

function makeTextEmbedder(): EmbeddingProvider & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  return {
    dimensions: 3,
    supportsMultimodal: false,
    embed: vi.fn(async (_t: string) => [1, 0, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
  };
}

function makeMultimodalEmbedder(): EmbeddingProvider & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
  embedMultimodal: ReturnType<typeof vi.fn>;
} {
  return {
    dimensions: 3,
    supportsMultimodal: true,
    embed: vi.fn(async (_t: string) => [1, 0, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
    embedMultimodal: vi.fn(async (_input: unknown) => [0.5, 0.5, 0]),
  };
}

describe("BaseVectorStore multimodal routing (via InMemoryVectorStore)", () => {
  describe("ensureEmbedding (upsert)", () => {
    it("routes string-only docs through embed()", async () => {
      const embedder = makeTextEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "1", content: "hello" });
      expect(embedder.embed).toHaveBeenCalledWith("hello");
    });

    it("routes docs with parts through embedMultimodal()", async () => {
      const embedder = makeMultimodalEmbedder();
      const store = new InMemoryVectorStore(embedder);
      const parts: ContentPart[] = [
        { type: "text", text: "caption" },
        { type: "image", data: "B64", mimeType: "image/png" },
      ];
      await store.upsert("col", { id: "1", content: "fallback text", parts });
      expect(embedder.embedMultimodal).toHaveBeenCalledWith(parts);
      expect(embedder.embed).not.toHaveBeenCalled();
    });

    it("throws helpful error when parts set but embedder is text-only", async () => {
      const embedder = makeTextEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await expect(
        store.upsert("col", {
          id: "1",
          content: "x",
          parts: [{ type: "image", data: "B64", mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/multimodal parts but .* is text-only/);
    });

    it("respects precomputed embedding even when parts are set", async () => {
      const embedder = makeMultimodalEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", {
        id: "1",
        content: "x",
        parts: [{ type: "text", text: "y" }],
        embedding: [0, 0, 1],
      });
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(embedder.embedMultimodal).not.toHaveBeenCalled();
      const got = await store.get("col", "1");
      expect(got).not.toBeNull();
    });
  });

  describe("ensureQueryVector (search)", () => {
    it("accepts number[] query and skips embedder", async () => {
      const embedder = makeMultimodalEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "1", content: "a", embedding: [1, 0, 0] });
      await store.search("col", [1, 0, 0]);
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(embedder.embedMultimodal).not.toHaveBeenCalled();
    });

    it("routes string queries through embed()", async () => {
      const embedder = makeMultimodalEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "1", content: "a", embedding: [1, 0, 0] });
      await store.search("col", "find me");
      expect(embedder.embed).toHaveBeenCalledWith("find me");
      expect(embedder.embedMultimodal).not.toHaveBeenCalled();
    });

    it("routes ContentPart[] queries through embedMultimodal()", async () => {
      const embedder = makeMultimodalEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "1", content: "a", embedding: [1, 0, 0] });

      const query: ContentPart[] = [{ type: "image", data: "B64", mimeType: "image/png" }];
      await store.search("col", query);
      expect(embedder.embedMultimodal).toHaveBeenCalledWith(query);
      expect(embedder.embed).not.toHaveBeenCalled();
    });

    it("throws when ContentPart[] query is used with a text-only embedder", async () => {
      const embedder = makeTextEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "1", content: "a", embedding: [1, 0, 0] });
      await expect(
        store.search("col", [{ type: "image", data: "B64", mimeType: "image/png" }]),
      ).rejects.toThrow(/Multimodal query requires/);
    });
  });

  describe("backwards compatibility", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("end-to-end string upsert + string search works without parts", async () => {
      const embedder = makeTextEmbedder();
      const store = new InMemoryVectorStore(embedder);
      await store.upsert("col", { id: "a", content: "hello world" });
      const results = await store.search("col", "hello world");
      expect(results).toHaveLength(1);
      expect(embedder.embed).toHaveBeenCalledTimes(2); // once for upsert, once for query
    });
  });
});
