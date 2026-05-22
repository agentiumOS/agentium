import { describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, ModelResponse, StreamChunk } from "../../models/types.js";
import type { CypherStore } from "../cypher-store.js";
import { HybridRetriever } from "../hybrid.js";
import { GraphRAGRetriever } from "../retriever.js";

function makeStubModel(text: string): ModelProvider {
  return {
    providerId: "stub",
    modelId: "stub",
    async generate(_messages: ChatMessage[]): Promise<ModelResponse> {
      return {
        message: { role: "assistant", content: text },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text };
    },
  };
}

function makeStubStore(records: Array<Record<string, unknown>>): CypherStore & { runCypher: any; getSchema: any } {
  return {
    providerId: "stub",
    connect: vi.fn(async () => {}),
    runCypher: vi.fn(async () => records.map((v) => ({ values: v }))),
    getSchema: vi.fn(async () => ({ nodeLabels: ["Person"], relationshipTypes: ["KNOWS"], propertyKeys: ["name"] })),
    close: vi.fn(async () => {}),
  };
}

describe("GraphRAGRetriever", () => {
  it("renders schema into the user prompt and runs returned Cypher", async () => {
    const store = makeStubStore([{ name: "alice" }, { name: "bob" }]);
    const model = makeStubModel("MATCH (p:Person) RETURN p.name AS name");
    const ret = new GraphRAGRetriever({ store, model });

    const result = await ret.retrieve("who do I know?");
    expect(store.runCypher).toHaveBeenCalled();
    expect(result.records).toHaveLength(2);
    expect(result.text).toContain("name=");
  });

  it("auto-appends LIMIT when missing", async () => {
    const store = makeStubStore([]);
    const model = makeStubModel("MATCH (n) RETURN n");
    const ret = new GraphRAGRetriever({ store, model, maxRecords: 7 });

    await ret.retrieve("anything");
    const cypherArg = store.runCypher.mock.calls[0][0];
    expect(cypherArg).toMatch(/LIMIT 7/);
  });

  it("does not double-append LIMIT", async () => {
    const store = makeStubStore([]);
    const model = makeStubModel("MATCH (n) RETURN n LIMIT 5");
    const ret = new GraphRAGRetriever({ store, model });

    await ret.retrieve("anything");
    const cypherArg = store.runCypher.mock.calls[0][0];
    expect(cypherArg.match(/LIMIT/g)?.length).toBe(1);
  });

  it("strips markdown code fences from model output", async () => {
    const store = makeStubStore([]);
    const model = makeStubModel("```cypher\nMATCH (n) RETURN n\n```");
    const ret = new GraphRAGRetriever({ store, model });
    await ret.retrieve("x");
    expect(store.runCypher.mock.calls[0][0]).not.toContain("```");
  });
});

describe("HybridRetriever", () => {
  it("fuses vector + graph results with RRF", async () => {
    const vectorStore: any = {
      search: vi.fn(async () => [
        { id: "v1", content: "doc1", score: 0.9, metadata: {} },
        { id: "v2", content: "doc2", score: 0.7, metadata: {} },
      ]),
      initialize: async () => {},
      upsert: async () => {},
      upsertBatch: async () => {},
      delete: async () => {},
      get: async () => null,
      dropCollection: async () => {},
      close: async () => {},
    };

    const cypherStore = makeStubStore([{ name: "alice" }, { name: "bob" }]);
    const model = makeStubModel("MATCH (n) RETURN n");
    const graphRet = new GraphRAGRetriever({ store: cypherStore, model });

    const hybrid = new HybridRetriever({
      vector: { store: vectorStore, collection: "docs", topK: 5 },
      graph: { retriever: graphRet },
      topK: 5,
    });

    const results = await hybrid.retrieve("query");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source === "vector")).toBe(true);
    expect(results.some((r) => r.source === "graph")).toBe(true);
  });

  it("works when only one retriever is configured", async () => {
    const vectorStore: any = {
      search: vi.fn(async () => [{ id: "v1", content: "doc", score: 0.9 }]),
      initialize: async () => {},
      upsert: async () => {},
      upsertBatch: async () => {},
      delete: async () => {},
      get: async () => null,
      dropCollection: async () => {},
      close: async () => {},
    };

    const hybrid = new HybridRetriever({ vector: { store: vectorStore, collection: "docs" }, topK: 3 });
    const results = await hybrid.retrieve("q");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("vector");
  });
});
