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

  describe("gemini-embedding-2 / multimodal", () => {
    it("defaults gemini-embedding-2 to 3072 dimensions", () => {
      const embedder = new GoogleEmbedding({ model: "gemini-embedding-2" });
      expect(embedder.dimensions).toBe(3072);
      expect(embedder.supportsMultimodal).toBe(true);
    });

    it("text-embedding-004 reports supportsMultimodal=false", () => {
      const embedder = new GoogleEmbedding();
      expect(embedder.supportsMultimodal).toBe(false);
    });

    it("embedMultimodal sends correct inlineData for text + base64 image", async () => {
      mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });

      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      const result = await embedder.embedMultimodal([
        { type: "text", text: "A photo of a dog" },
        { type: "image", data: "BASE64IMG", mimeType: "image/png" },
      ]);

      expect(result).toEqual([0.1, 0.2, 0.3]);
      const call = mockEmbedContent.mock.calls[0][0];
      expect(call.model).toBe("gemini-embedding-2");
      expect(call.contents).toEqual([
        { text: "A photo of a dog" },
        { inlineData: { data: "BASE64IMG", mimeType: "image/png" } },
      ]);
    });

    it("embedMultimodal accepts a string and wraps it as TextPart", async () => {
      mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [1, 2] }] });

      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      await embedder.embedMultimodal("just text");

      expect(mockEmbedContent.mock.calls[0][0].contents).toEqual([{ text: "just text" }]);
    });

    it("embedMultimodal fetches ImagePart with URL data into base64", async () => {
      mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [0.5] }] });

      const fakeFetch = vi.fn().mockResolvedValue({
        ok: true,
        statusText: "OK",
        status: 200,
        headers: { get: (h: string) => (h === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      });
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = fakeFetch;
      try {
        const embedder = makeEmbedder({ model: "gemini-embedding-2" });
        await embedder.embedMultimodal([{ type: "image", data: "https://example.com/img.jpg" }]);

        expect(fakeFetch).toHaveBeenCalledWith("https://example.com/img.jpg");
        const parts = mockEmbedContent.mock.calls[0][0].contents;
        expect(parts[0].inlineData.mimeType).toBe("image/jpeg");
        expect(parts[0].inlineData.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("embedMultimodal routes FilePart with video/mp4 through inlineData", async () => {
      mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [0.9] }] });

      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      await embedder.embedMultimodal([
        { type: "file", data: "VIDEOBASE64", mimeType: "video/mp4", filename: "clip.mp4" },
      ]);

      expect(mockEmbedContent.mock.calls[0][0].contents[0]).toEqual({
        inlineData: { data: "VIDEOBASE64", mimeType: "video/mp4" },
      });
    });

    it("embedMultimodal routes FilePart with application/pdf through inlineData", async () => {
      mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [0.7] }] });

      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      await embedder.embedMultimodal([{ type: "file", data: "PDFBASE64", mimeType: "application/pdf" }]);

      expect(mockEmbedContent.mock.calls[0][0].contents[0]).toEqual({
        inlineData: { data: "PDFBASE64", mimeType: "application/pdf" },
      });
    });

    it("embedMultimodal throws when model is text-embedding-004", async () => {
      const embedder = makeEmbedder();
      await expect(embedder.embedMultimodal([{ type: "text", text: "hi" }])).rejects.toThrow(
        /does not support multimodal/,
      );
      expect(mockEmbedContent).not.toHaveBeenCalled();
    });

    it("embedMultimodal throws on unsupported FilePart MIME", async () => {
      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      await expect(
        embedder.embedMultimodal([{ type: "file", data: "X", mimeType: "application/zip" }]),
      ).rejects.toThrow(/Unsupported MIME type/);
    });

    it("embedMultimodal retries on 429 then succeeds", async () => {
      const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
      mockEmbedContent
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ embeddings: [{ values: [0.42] }] });

      const embedder = makeEmbedder({ model: "gemini-embedding-2" });
      const result = await embedder.embedMultimodal([{ type: "text", text: "retry me" }]);
      expect(result).toEqual([0.42]);
      expect(mockEmbedContent).toHaveBeenCalledTimes(2);
    });
  });
});

describe("existing embedders stay symmetric", () => {
  it("does not add embedQuery to OpenAI, Google, or hash embedders", async () => {
    const openai = await import("../openai.js");
    const google = await import("../google.js");
    const hash = await import("../hash.js");
    expect(openai.OpenAIEmbedding.prototype).not.toHaveProperty("embedQuery");
    expect(google.GoogleEmbedding.prototype).not.toHaveProperty("embedQuery");
    expect(hash.HashEmbedding.prototype).not.toHaveProperty("embedQuery");
    expect(openai.OpenAIEmbedding.prototype).not.toHaveProperty("embedMultimodalQuery");
    expect(google.GoogleEmbedding.prototype).not.toHaveProperty("embedMultimodalQuery");
    expect(hash.HashEmbedding.prototype).not.toHaveProperty("embedMultimodalQuery");
  });
});

describe("EmbeddingGemmaEmbedding", () => {
  let EmbeddingGemmaEmbedding: typeof import("../embeddinggemma.js").EmbeddingGemmaEmbedding;

  beforeEach(async () => {
    ({ EmbeddingGemmaEmbedding } = await import("../embeddinggemma.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function vector(length: number, fill = 1): number[] {
    return new Array(length).fill(fill);
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  describe("constructor", () => {
    it("defaults to the Ollama EmbeddingGemma tag at 768 dimensions", () => {
      const embedder = new EmbeddingGemmaEmbedding();
      expect(embedder.dimensions).toBe(768);
      expect(embedder.supportsMultimodal).toBe(true);
    });

    it("rejects dimensions outside 128 through 768", () => {
      expect(() => new EmbeddingGemmaEmbedding({ dimensions: 64 })).toThrow(/128 to 768/);
      expect(() => new EmbeddingGemmaEmbedding({ dimensions: 1024 })).toThrow(/128 to 768/);
      expect(() => new EmbeddingGemmaEmbedding({ dimensions: 256.5 })).toThrow(/128 to 768/);
    });

    it("rejects an unknown task", () => {
      expect(() => new EmbeddingGemmaEmbedding({ task: "translate" as "retrieval" })).toThrow(
        /Unknown EmbeddingGemma task/,
      );
    });
  });

  describe("ollama text embeddings", () => {
    it("prefixes documents and queries differently for retrieval", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [vector(768)] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();

      await embedder.embed("shipping delays");
      await embedder.embedQuery("why is the shipment late");

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:11434/api/embed",
        expect.objectContaining({ method: "POST" }),
      );
      const documentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const queryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(documentBody).toEqual({
        model: "embeddinggemma-2",
        input: ["title: none | text: shipping delays"],
      });
      expect(queryBody.input).toEqual(["task: search result | query: why is the shipment late"]);
    });

    it("uses the code prompt and a caller-supplied document title", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [vector(768)], prompt_eval_count: 12 }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({
        task: "code",
        documentPrompt: "title: src/store.ts | text: ",
      });

      await embedder.embed("export const store = 1;");
      await embedder.embedQuery("where is the store created");

      const documentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const queryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(documentBody.input).toEqual(["title: src/store.ts | text: export const store = 1;"]);
      expect(queryBody.input).toEqual(["task: code retrieval | query: where is the store created"]);
    });

    it("truncates a 768-vector to 128 and re-normalizes", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ embeddings: [vector(768)] })),
      );
      const embedder = new EmbeddingGemmaEmbedding({ dimensions: 128 });
      const result = await embedder.embed("hello");
      expect(result).toHaveLength(128);
      const norm = Math.hypot(...result);
      expect(norm).toBeCloseTo(1);
    });

    it("keeps a vector that is already the requested length", async () => {
      const returned = vector(256, 0);
      returned[0] = 1;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ embeddings: [returned] })),
      );
      const embedder = new EmbeddingGemmaEmbedding({ dimensions: 256 });
      await expect(embedder.embed("hello")).resolves.toEqual(returned);
    });

    it("retries a 429 and then reads the vector", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("busy", { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ embeddings: [vector(768, 0.5)] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();
      const result = await embedder.embed("retry");
      expect(result).toHaveLength(768);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("sends one image as base64 and prefixes the text for a document", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [vector(768)] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();

      await embedder.embedMultimodal([
        { type: "text", text: "a cat on a windowsill" },
        { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
      ]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        model: "embeddinggemma-2",
        input: { text: "title: none | text: a cat on a windowsill", image: "iVBORw0KGgo" },
      });
    });

    it("fetches an image URL and sends several images as an array", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).startsWith("https://")) {
          return new Response(Buffer.from("fetched-image"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        return jsonResponse({ embeddings: [vector(768)] });
      });
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();

      await embedder.embedMultimodal([
        { type: "image", data: "https://example.com/a.png" },
        { type: "image", data: "SECOND" },
        { type: "audio", data: "UklGRiQA", mimeType: "audio/wav" },
      ]);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.input.image).toEqual([Buffer.from("fetched-image").toString("base64"), "SECOND"]);
      expect(body.input.audio).toBe("UklGRiQA");
      expect(body.input.text).toBeUndefined();
    });

    it("rejects video and pdf without calling the server", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();
      await expect(embedder.embedMultimodal([{ type: "file", data: "MP4", mimeType: "video/mp4" }])).rejects.toThrow(
        /does not accept video/,
      );
      await expect(
        embedder.embedMultimodal([{ type: "file", data: "PDF", mimeType: "application/pdf" }]),
      ).rejects.toThrow(/Unsupported MIME type/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps a text-only multimodal call on the text embed request", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [vector(768)] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();
      await embedder.embedMultimodal("shipping delays");
      await embedder.embedMultimodalQuery("why is the shipment late");
      const documentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const queryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(documentBody.input).toEqual(["title: none | text: shipping delays"]);
      expect(queryBody.input).toEqual(["task: search result | query: why is the shipment late"]);
    });

    it("does not retry a 400", async () => {
      const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding();
      await expect(embedder.embed("bad")).rejects.toThrow(/400/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("openai-compatible server", () => {
    it("posts to /embeddings, sorts by index, and asks for a shorter dimension", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          data: [
            { embedding: vector(256, 2), index: 1 },
            { embedding: vector(256, 3), index: 0 },
          ],
          usage: { prompt_tokens: 9, total_tokens: 9 },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({
        backend: "openai",
        baseURL: "http://localhost:8000/v1/",
        apiKey: "local",
        dimensions: 256,
        model: "google/embeddinggemma-2",
      });

      const results = await embedder.embedBatch(["alpha", "beta"]);
      expect(results).toHaveLength(2);
      expect(results[0]![0]).toBe(3);
      expect(results[1]![0]).toBe(2);

      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8000/v1/embeddings");
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        model: "google/embeddinggemma-2",
        input: ["title: none | text: alpha", "title: none | text: beta"],
        dimensions: 256,
      });
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer local");
    });

    it("uses one prefix for classification on both sides", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: vector(768), index: 0 }] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({ backend: "openai", task: "classification" });
      await embedder.embed("The battery died");
      await embedder.embedQuery("Negative");
      const documentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      const queryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(documentBody.input).toEqual(["task: classification | query: The battery died"]);
      expect(queryBody.input).toEqual(["task: classification | query: Negative"]);
      expect(documentBody.dimensions).toBeUndefined();
    });

    it("sends image, audio, and video as chat content and prefixes only the text", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: vector(768), index: 0 }] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({ backend: "openai", apiKey: "local" });

      await embedder.embedMultimodal([
        { type: "text", text: "running shoes" },
        { type: "image", data: "SHOES", mimeType: "image/jpeg" },
        { type: "audio", data: "WAVDATA", mimeType: "audio/wav" },
        { type: "file", data: "MP4DATA", mimeType: "video/mp4" },
      ]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "title: none | text: running shoes" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,SHOES" } },
            { type: "input_audio", input_audio: { data: "WAVDATA", format: "wav" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,MP4DATA" } },
          ],
        },
      ]);
      expect(body.input).toBeUndefined();
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer local");
    });

    it("uses the query prompt for a multimodal query and leaves a remote image URL in place", async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ data: [{ embedding: vector(768), index: 0 }] }));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({ backend: "openai" });

      await embedder.embedMultimodalQuery([
        { type: "image", data: "https://example.com/cat.png", mimeType: "image/png" },
        { type: "text", text: "task: search result | query: orange cat" },
      ]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content).toEqual([
        { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        { type: "text", text: "task: search result | query: orange cat" },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns no vectors and makes no request for an empty batch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new EmbeddingGemmaEmbedding({ backend: "openai" });
      await expect(embedder.embedBatch([])).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
