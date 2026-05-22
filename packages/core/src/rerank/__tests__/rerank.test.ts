import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CohereReranker tests
// ---------------------------------------------------------------------------

describe("CohereReranker", () => {
  const origKey = process.env.COHERE_API_KEY;
  let CohereReranker: any;
  let mockRerank: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    process.env.COHERE_API_KEY = "test-cohere-key";
    mockRerank = vi.fn();
    const mod = await import("../providers/cohere.js");
    CohereReranker = mod.CohereReranker;
  });

  afterEach(() => {
    if (origKey) process.env.COHERE_API_KEY = origKey;
    else delete process.env.COHERE_API_KEY;
  });

  function makeReranker(config?: Record<string, unknown>) {
    const r = new CohereReranker(config);
    (r as any).client = { rerank: mockRerank };
    return r;
  }

  it("returns reranked results sorted by score", async () => {
    mockRerank.mockResolvedValueOnce({
      results: [
        { index: 2, relevanceScore: 0.95 },
        { index: 0, relevanceScore: 0.4 },
        { index: 1, relevanceScore: 0.1 },
      ],
    });

    const reranker = makeReranker();
    const result = await reranker.rerank("query", [
      { id: "a", content: "alpha" },
      { id: "b", content: "beta" },
      { id: "c", content: "gamma" },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ index: 2, score: 0.95, content: "gamma", id: "c", metadata: undefined });
    expect(result[1].id).toBe("a");
  });

  it("passes the correct model and topN to the API", async () => {
    mockRerank.mockResolvedValueOnce({ results: [{ index: 0, relevanceScore: 1 }] });

    const reranker = makeReranker({ model: "rerank-multilingual-v3.5" });
    await reranker.rerank("query", [{ id: "a", content: "alpha" }], { topK: 1 });

    expect(mockRerank.mock.calls[0][0]).toMatchObject({
      model: "rerank-multilingual-v3.5",
      query: "query",
      topN: 1,
    });
  });

  it("accepts string documents", async () => {
    mockRerank.mockResolvedValueOnce({
      results: [
        { index: 1, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.5 },
      ],
    });

    const reranker = makeReranker();
    const result = await reranker.rerank("query", ["alpha", "beta"]);
    expect(result[0].content).toBe("beta");
    expect(result[0].id).toBeUndefined();
  });

  it("filters by minScore when provided", async () => {
    mockRerank.mockResolvedValueOnce({
      results: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.3 },
      ],
    });

    const reranker = makeReranker();
    const result = await reranker.rerank("q", [{ content: "a" }, { content: "b" }], { minScore: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  it("returns empty array for empty input", async () => {
    const reranker = makeReranker();
    expect(await reranker.rerank("q", [])).toEqual([]);
    expect(mockRerank).not.toHaveBeenCalled();
  });

  it("retries on 429 then succeeds", async () => {
    const rateLimit = Object.assign(new Error("rate limited"), { status: 429 });
    mockRerank.mockRejectedValueOnce(rateLimit).mockResolvedValueOnce({
      results: [{ index: 0, relevanceScore: 0.5 }],
    });

    const reranker = makeReranker();
    await reranker.rerank("q", [{ content: "a" }]);
    expect(mockRerank).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// VoyageReranker tests (uses raw fetch)
// ---------------------------------------------------------------------------

describe("VoyageReranker", () => {
  const origKey = process.env.VOYAGE_API_KEY;
  let VoyageReranker: any;
  let mockFetch: ReturnType<typeof vi.fn>;
  let origFetch: any;

  beforeEach(async () => {
    process.env.VOYAGE_API_KEY = "test-voyage-key";
    mockFetch = vi.fn();
    origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = mockFetch;
    const mod = await import("../providers/voyage.js");
    VoyageReranker = mod.VoyageReranker;
  });

  afterEach(() => {
    if (origKey) process.env.VOYAGE_API_KEY = origKey;
    else delete process.env.VOYAGE_API_KEY;
    (globalThis as any).fetch = origFetch;
  });

  it("returns reranked results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    });

    const reranker = new VoyageReranker();
    const result = await reranker.rerank("q", [
      { id: "a", content: "alpha" },
      { id: "b", content: "beta" },
    ]);
    expect(result[0].id).toBe("b");
    expect(result[0].score).toBe(0.9);
  });

  it("throws when API returns non-ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    });

    const reranker = new VoyageReranker();
    // No retry on a single 500 with default retries=2: it WILL retry. Make all 3 fail.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    });
    await expect(reranker.rerank("q", [{ content: "a" }])).rejects.toThrow(/Voyage rerank failed/);
  });

  it("throws when api key missing", async () => {
    delete process.env.VOYAGE_API_KEY;
    const reranker = new VoyageReranker();
    await expect(reranker.rerank("q", [{ content: "a" }])).rejects.toThrow(/missing API key/);
  });
});

// ---------------------------------------------------------------------------
// JinaReranker tests (uses raw fetch)
// ---------------------------------------------------------------------------

describe("JinaReranker", () => {
  const origKey = process.env.JINA_API_KEY;
  let JinaReranker: any;
  let mockFetch: ReturnType<typeof vi.fn>;
  let origFetch: any;

  beforeEach(async () => {
    process.env.JINA_API_KEY = "test-jina-key";
    mockFetch = vi.fn();
    origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = mockFetch;
    const mod = await import("../providers/jina.js");
    JinaReranker = mod.JinaReranker;
  });

  afterEach(() => {
    if (origKey) process.env.JINA_API_KEY = origKey;
    else delete process.env.JINA_API_KEY;
    (globalThis as any).fetch = origFetch;
  });

  it("returns reranked results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 1, relevance_score: 0.3 },
        ],
      }),
    });

    const reranker = new JinaReranker();
    const result = await reranker.rerank("q", [
      { id: "x", content: "alpha" },
      { id: "y", content: "beta" },
    ]);
    expect(result[0].id).toBe("x");
    expect(result[0].score).toBe(0.95);
  });

  it("passes the right model and top_n", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }),
    });

    const reranker = new JinaReranker({ model: "jina-reranker-v3" });
    await reranker.rerank("hello", [{ content: "world" }], { topK: 5 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("jina-reranker-v3");
    expect(body.top_n).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ColbertReranker tests (local pipeline mock)
// ---------------------------------------------------------------------------

describe("ColbertReranker", () => {
  let ColbertReranker: any;
  let mockPipelineFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockPipelineFn = vi.fn();
    const mod = await import("../providers/colbert.js");
    ColbertReranker = mod.ColbertReranker;
  });

  function makeReranker(config?: Record<string, unknown>) {
    const r = new ColbertReranker(config);
    (r as any).pipelinePromise = Promise.resolve(mockPipelineFn);
    return r;
  }

  it("scores each document and sorts descending", async () => {
    mockPipelineFn
      .mockResolvedValueOnce([{ score: 0.4 }])
      .mockResolvedValueOnce([{ score: 0.9 }])
      .mockResolvedValueOnce([{ score: 0.1 }]);

    const reranker = makeReranker();
    const result = await reranker.rerank("q", [
      { id: "a", content: "alpha" },
      { id: "b", content: "beta" },
      { id: "c", content: "gamma" },
    ]);
    expect(result[0].id).toBe("b");
    expect(result[0].score).toBe(0.9);
    expect(result[2].id).toBe("c");
  });

  it("respects topK", async () => {
    mockPipelineFn.mockResolvedValueOnce([{ score: 0.5 }]).mockResolvedValueOnce([{ score: 0.9 }]);

    const reranker = makeReranker();
    const result = await reranker.rerank("q", [{ content: "a" }, { content: "b" }], { topK: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("b");
  });

  it("returns empty array for empty input", async () => {
    const reranker = makeReranker();
    expect(await reranker.rerank("q", [])).toEqual([]);
    expect(mockPipelineFn).not.toHaveBeenCalled();
  });
});
