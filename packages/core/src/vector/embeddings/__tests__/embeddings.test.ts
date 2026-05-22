import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// OpenAI Embedding Tests
// ---------------------------------------------------------------------------

describe("OpenAIEmbedding", () => {
  const origKey = process.env.OPENAI_API_KEY;
  let OpenAIEmbedding: any;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "test-key";
    mockCreate = vi.fn();

    const mod = await import("../openai.js");
    OpenAIEmbedding = mod.OpenAIEmbedding;
  });

  afterEach(() => {
    if (origKey) process.env.OPENAI_API_KEY = origKey;
    else delete process.env.OPENAI_API_KEY;
  });

  function makeEmbedder(config?: Record<string, unknown>) {
    const embedder = new OpenAIEmbedding(config);
    (embedder as any).client = { embeddings: { create: mockCreate } };
    return embedder;
  }

  describe("constructor", () => {
    it("defaults to text-embedding-3-small with 1536 dimensions", () => {
      const embedder = new OpenAIEmbedding();
      expect(embedder.dimensions).toBe(1536);
    });

    it("uses custom model dimensions", () => {
      const embedder = new OpenAIEmbedding({ model: "text-embedding-3-large" });
      expect(embedder.dimensions).toBe(3072);
    });

    it("uses text-embedding-ada-002 dimensions", () => {
      const embedder = new OpenAIEmbedding({ model: "text-embedding-ada-002" });
      expect(embedder.dimensions).toBe(1536);
    });

    it("allows overriding dimensions", () => {
      const embedder = new OpenAIEmbedding({ dimensions: 512 });
      expect(embedder.dimensions).toBe(512);
    });

    it("falls back to 1536 for unknown model", () => {
      const embedder = new OpenAIEmbedding({ model: "some-future-model" });
      expect(embedder.dimensions).toBe(1536);
    });
  });

  describe("embed()", () => {
    it("returns embedding vector from API", async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: mockEmbedding, index: 0 }],
      });

      const embedder = makeEmbedder();
      const result = await embedder.embed("hello world");

      expect(result).toEqual(mockEmbedding);
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it("passes the correct model to the API", async () => {
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: [0.1], index: 0 }],
      });

      const embedder = makeEmbedder({ model: "text-embedding-3-large" });
      await embedder.embed("test");

      expect(mockCreate.mock.calls[0][0].model).toBe("text-embedding-3-large");
    });

    it("includes dimensions param when overridden", async () => {
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: [0.1], index: 0 }],
      });

      const embedder = makeEmbedder({ dimensions: 256 });
      await embedder.embed("test");

      expect(mockCreate.mock.calls[0][0].dimensions).toBe(256);
    });
  });

  describe("embedBatch()", () => {
    it("returns multiple embeddings sorted by index", async () => {
      mockCreate.mockResolvedValueOnce({
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      });

      const embedder = makeEmbedder();
      const results = await embedder.embedBatch(["first", "second"]);

      expect(results).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
    });
  });

  describe("withRetry", () => {
    it("retries on 429 rate limit error", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: [{ embedding: [0.1], index: 0 }] });

      const embedder = makeEmbedder();
      const result = await embedder.embed("test");

      expect(result).toEqual([0.1]);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("retries on 500 server error", async () => {
      const serverError = Object.assign(new Error("server error"), { status: 500 });
      mockCreate.mockRejectedValueOnce(serverError).mockResolvedValueOnce({ data: [{ embedding: [0.2], index: 0 }] });

      const embedder = makeEmbedder();
      const result = await embedder.embed("test");

      expect(result).toEqual([0.2]);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("retries on 502 and 503 errors", async () => {
      const error502 = Object.assign(new Error("bad gateway"), { status: 502 });
      mockCreate.mockRejectedValueOnce(error502).mockResolvedValueOnce({ data: [{ embedding: [0.3], index: 0 }] });

      const embedder = makeEmbedder();
      const result = await embedder.embed("test");

      expect(result).toEqual([0.3]);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("does not retry on 400 client error", async () => {
      const clientError = Object.assign(new Error("bad request"), { status: 400 });
      mockCreate.mockRejectedValue(clientError);

      const embedder = makeEmbedder();
      await expect(embedder.embed("bad")).rejects.toThrow("bad request");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("does not retry on 404 error", async () => {
      const notFoundError = Object.assign(new Error("not found"), { status: 404 });
      mockCreate.mockRejectedValue(notFoundError);

      const embedder = makeEmbedder();
      await expect(embedder.embed("test")).rejects.toThrow("not found");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries then throws", async () => {
      const serverError = Object.assign(new Error("overloaded"), { status: 503 });
      mockCreate.mockRejectedValue(serverError);

      const embedder = makeEmbedder();
      await expect(embedder.embed("test")).rejects.toThrow("overloaded");
      expect(mockCreate).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });
});

// ---------------------------------------------------------------------------
// Google Embedding Tests
// ---------------------------------------------------------------------------

describe("GoogleEmbedding", () => {
  const origKey = process.env.GOOGLE_API_KEY;
  let GoogleEmbedding: any;
  let mockEmbedContent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.GOOGLE_API_KEY = "test-google-key";
    mockEmbedContent = vi.fn();

    const mod = await import("../google.js");
    GoogleEmbedding = mod.GoogleEmbedding;
  });

  afterEach(() => {
    if (origKey) process.env.GOOGLE_API_KEY = origKey;
    else delete process.env.GOOGLE_API_KEY;
  });

  function makeEmbedder(config?: Record<string, unknown>) {
    const embedder = new GoogleEmbedding(config);
    (embedder as any).ai = { models: { embedContent: mockEmbedContent } };
    return embedder;
  }

  describe("constructor", () => {
    it("defaults to text-embedding-004 with 768 dimensions", () => {
      const embedder = new GoogleEmbedding();
      expect(embedder.dimensions).toBe(768);
    });

    it("allows overriding dimensions", () => {
      const embedder = new GoogleEmbedding({ dimensions: 256 });
      expect(embedder.dimensions).toBe(256);
    });

    it("falls back to 768 for unknown model", () => {
      const embedder = new GoogleEmbedding({ model: "future-model" });
      expect(embedder.dimensions).toBe(768);
    });
  });

  describe("embed()", () => {
    it("returns embedding vector from API", async () => {
      const mockValues = [0.5, 0.6, 0.7];
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: mockValues }],
      });

      const embedder = makeEmbedder();
      const result = await embedder.embed("hello");

      expect(result).toEqual(mockValues);
      expect(mockEmbedContent).toHaveBeenCalledOnce();
    });

    it("passes the correct model to the API", async () => {
      mockEmbedContent.mockResolvedValueOnce({
        embeddings: [{ values: [0.1] }],
      });

      const embedder = makeEmbedder({ model: "embedding-001" });
      await embedder.embed("test");

      expect(mockEmbedContent.mock.calls[0][0].model).toBe("embedding-001");
    });
  });

  describe("embedBatch()", () => {
    it("embeds multiple texts", async () => {
      mockEmbedContent
        .mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2] }] })
        .mockResolvedValueOnce({ embeddings: [{ values: [0.3, 0.4] }] });

      const embedder = makeEmbedder();
      const results = await embedder.embedBatch(["first", "second"]);

      expect(results).toEqual([
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
    });
  });

  describe("withRetry", () => {
    it("retries on 429 and succeeds", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      mockEmbedContent.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce({ embeddings: [{ values: [0.1] }] });

      const embedder = makeEmbedder();
      const result = await embedder.embed("test");

      expect(result).toEqual([0.1]);
      expect(mockEmbedContent).toHaveBeenCalledTimes(2);
    });

    it("does not retry on 400", async () => {
      const clientError = Object.assign(new Error("bad request"), { status: 400 });
      mockEmbedContent.mockRejectedValue(clientError);

      const embedder = makeEmbedder();
      await expect(embedder.embed("bad")).rejects.toThrow("bad request");
      expect(mockEmbedContent).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries then throws", async () => {
      const serverError = Object.assign(new Error("overloaded"), { status: 503 });
      mockEmbedContent.mockRejectedValue(serverError);

      const embedder = makeEmbedder();
      await expect(embedder.embed("test")).rejects.toThrow("overloaded");
      expect(mockEmbedContent).toHaveBeenCalledTimes(3);
    });
  });
});
