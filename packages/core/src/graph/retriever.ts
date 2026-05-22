import type { ModelProvider } from "../models/provider.js";
import type { ChatMessage } from "../models/types.js";
import type { CypherRecord, CypherStore } from "./cypher-store.js";

export interface GraphRAGRetrieverConfig {
  store: CypherStore;
  model: ModelProvider;
  /** Optional system prompt prepended to the LLM-to-Cypher call. */
  systemPrompt?: string;
  /** Max records returned from a single query (after `LIMIT` is appended if missing). */
  maxRecords?: number;
}

export interface GraphRAGResult {
  cypher: string;
  records: CypherRecord[];
  /** Plain-text rendering of the records, useful as RAG context. */
  text: string;
}

const DEFAULT_SYSTEM = `You convert a natural-language question into a Cypher query that runs against a Neo4j-compatible graph.
Rules:
1. Use ONLY the labels and relationship types listed in the schema.
2. Return only Cypher - no prose, no markdown fences.
3. Always end with a LIMIT clause (default 25 rows).
4. Prefer MATCH ... RETURN over WRITE operations.`;

function stripCodeFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:cypher|sql)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
}

function ensureLimit(cypher: string, max: number): string {
  if (/\blimit\b/i.test(cypher)) return cypher;
  return `${cypher.replace(/;$/, "")} LIMIT ${max}`;
}

export class GraphRAGRetriever {
  private store: CypherStore;
  private model: ModelProvider;
  private systemPrompt: string;
  private maxRecords: number;

  constructor(config: GraphRAGRetrieverConfig) {
    this.store = config.store;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM;
    this.maxRecords = config.maxRecords ?? 25;
  }

  /** Translate a natural-language query to Cypher, run it, and return rows. */
  async retrieve(query: string): Promise<GraphRAGResult> {
    await this.store.connect();
    const schema = await this.store.getSchema();

    const userPrompt = [
      `Schema:`,
      `  node labels: ${schema.nodeLabels.join(", ") || "(none)"}`,
      `  relationship types: ${schema.relationshipTypes.join(", ") || "(none)"}`,
      schema.propertyKeys?.length ? `  property keys: ${schema.propertyKeys.join(", ")}` : "",
      "",
      `Question: ${query}`,
    ]
      .filter(Boolean)
      .join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.model.generate(messages);
    const respContent = response.message.content;
    const respText =
      typeof respContent === "string"
        ? respContent
        : (respContent ?? []).map((p: any) => ("text" in p ? p.text : "")).join("");
    const cypherRaw = stripCodeFence(respText);
    const cypher = ensureLimit(cypherRaw, this.maxRecords);

    const records = await this.store.runCypher(cypher);
    const renderedText = records
      .map((r) =>
        Object.entries(r.values)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(", "),
      )
      .join("\n");

    return { cypher, records, text: renderedText };
  }
}
