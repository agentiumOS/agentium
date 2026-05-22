import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface PageIndexConfig {
  /** PageIndex API key. Falls back to PAGEINDEX_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Default: https://api.pageindex.ai */
  apiBase?: string;
  /** Request timeout in ms. Default: 120000 (2 min — PDF processing can be slow). */
  timeout?: number;
  /** Max response characters. Default: 50000. */
  maxResponseSize?: number;
}

const DEFAULT_API_BASE = "https://api.pageindex.ai";
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_RESPONSE = 50_000;

/**
 * PageIndex Toolkit — vectorless, reasoning-based RAG for long documents.
 *
 * Integrates with the PageIndex API to submit PDFs, generate tree indexes,
 * and perform reasoning-based retrieval and chat over documents.
 *
 * @example
 * ```ts
 * const pageindex = new PageIndexToolkit({ apiKey: "pi_..." });
 * const agent = new Agent({ tools: [...pageindex.getTools()] });
 * ```
 *
 * @see https://docs.pageindex.ai
 */
export class PageIndexToolkit extends Toolkit {
  readonly name = "pageindex";
  private config: PageIndexConfig;

  constructor(config: PageIndexConfig = {}) {
    super();
    this.config = config;
  }

  private get apiKey(): string {
    const key = this.config.apiKey ?? process.env.PAGEINDEX_API_KEY;
    if (!key) throw new Error("PageIndex API key is required. Set apiKey or PAGEINDEX_API_KEY env var.");
    return key;
  }

  private get apiBase(): string {
    return (this.config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout ?? DEFAULT_TIMEOUT);

    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          api_key: this.apiKey,
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`PageIndex API ${res.status}: ${text || res.statusText}`);
      }

      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private truncate(text: string): string {
    const max = this.config.maxResponseSize ?? DEFAULT_MAX_RESPONSE;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n...(truncated, ${text.length} total chars)`;
  }

  getTools(): ToolDef[] {
    return [
      this.submitDocumentTool(),
      this.getDocumentStatusTool(),
      this.getTreeTool(),
      this.listDocumentsTool(),
      this.chatTool(),
      this.retrieveTool(),
      this.deleteDocumentTool(),
    ];
  }

  private submitDocumentTool(): ToolDef {
    return {
      name: "pageindex_submit",
      description:
        "Submit a PDF document to PageIndex for tree indexing and reasoning-based RAG. Returns a doc_id for subsequent operations. The document will be processed asynchronously — use pageindex_status to check progress.",
      parameters: z.object({
        url: z.string().describe("Public URL of the PDF document to submit"),
        mode: z
          .enum(["default", "mcp"])
          .optional()
          .describe("Processing mode. Use 'mcp' to make accessible via PageIndex MCP."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const pdfUrl = args.url as string;
        const mode = args.mode as string | undefined;

        const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`Failed to download PDF from ${pdfUrl}: ${res.status}`);
        const buffer = await res.arrayBuffer();

        const formData = new FormData();
        formData.append("file", new Blob([buffer], { type: "application/pdf" }), "document.pdf");
        if (mode) formData.append("mode", mode);

        const result = await this.request("/doc/", {
          method: "POST",
          body: formData,
        });

        return JSON.stringify(result, null, 2);
      },
    };
  }

  private getDocumentStatusTool(): ToolDef {
    return {
      name: "pageindex_status",
      description:
        "Check the processing status of a PageIndex document. Returns status ('processing' or 'completed'), tree structure (when complete), and metadata.",
      parameters: z.object({
        docId: z.string().describe("PageIndex document ID (e.g. 'pi-abc123def456')"),
        type: z.enum(["tree", "ocr"]).optional().describe("Result type to fetch. Default: tree."),
        summary: z.boolean().optional().describe("Include node summaries in tree results."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const docId = args.docId as string;
        const type = args.type as string | undefined;
        const summary = args.summary as boolean | undefined;

        const params = new URLSearchParams();
        if (type) params.set("type", type);
        if (summary) params.set("summary", "true");

        const qs = params.toString();
        const result = await this.request(`/doc/${docId}/${qs ? `?${qs}` : ""}`);
        return this.truncate(JSON.stringify(result, null, 2));
      },
    };
  }

  private getTreeTool(): ToolDef {
    return {
      name: "pageindex_tree",
      description:
        "Get the hierarchical tree structure of a processed PageIndex document. The tree represents the document's semantic structure with titles, summaries, and page references — like an intelligent table of contents.",
      parameters: z.object({
        docId: z.string().describe("PageIndex document ID"),
        summary: z.boolean().optional().describe("Include node summaries. Default: false."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const docId = args.docId as string;
        const summary = args.summary as boolean | undefined;

        const params = new URLSearchParams({ type: "tree" });
        if (summary) params.set("summary", "true");

        const result = await this.request(`/doc/${docId}/?${params.toString()}`);
        return this.truncate(JSON.stringify(result, null, 2));
      },
    };
  }

  private listDocumentsTool(): ToolDef {
    return {
      name: "pageindex_list",
      description: "List all PageIndex documents. Returns IDs, names, statuses, and page counts.",
      parameters: z.object({
        limit: z.number().optional().describe("Max documents to return (1-100). Default: 50."),
        offset: z.number().optional().describe("Number of documents to skip for pagination."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const params = new URLSearchParams();
        if (args.limit) params.set("limit", String(args.limit));
        if (args.offset) params.set("offset", String(args.offset));

        const qs = params.toString();
        const result = await this.request(`/docs${qs ? `?${qs}` : ""}`);
        return JSON.stringify(result, null, 2);
      },
    };
  }

  private chatTool(): ToolDef {
    return {
      name: "pageindex_chat",
      description:
        "Ask questions about PageIndex documents using reasoning-based RAG. Uses LLM tree search for context-aware retrieval — much more accurate than vector search for complex professional documents (financial reports, legal filings, technical manuals). Supports single or multiple documents.",
      parameters: z.object({
        query: z.string().describe("Question or instruction about the document(s)"),
        docId: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Document ID or array of IDs to scope the query to"),
        temperature: z.number().optional().describe("Sampling temperature (0.0-1.0). Lower = more deterministic."),
        enableCitations: z.boolean().optional().describe("Include inline citations in the response."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const body: Record<string, unknown> = {
          messages: [{ role: "user", content: args.query as string }],
          stream: false,
        };
        if (args.docId) body.doc_id = args.docId;
        if (args.temperature !== undefined) body.temperature = args.temperature;
        if (args.enableCitations) body.enable_citations = true;

        const result = await this.request("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const content = result?.choices?.[0]?.message?.content;
        if (content) return this.truncate(content);
        return this.truncate(JSON.stringify(result, null, 2));
      },
    };
  }

  private retrieveTool(): ToolDef {
    return {
      name: "pageindex_retrieve",
      description:
        "Retrieve relevant sections from a PageIndex document using reasoning-based tree search. Returns specific nodes with page references and content. Best for extracting precise information from long documents.",
      parameters: z.object({
        query: z.string().describe("The question or information need"),
        docId: z.string().describe("PageIndex document ID to retrieve from"),
        thinking: z
          .boolean()
          .optional()
          .describe("Enable planning step before retrieval for more comprehensive results."),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        const submitResult = await this.request("/retrieval/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            doc_id: args.docId,
            query: args.query,
            thinking: args.thinking ?? false,
          }),
        });

        const retrievalId = submitResult?.retrieval_id;
        if (!retrievalId) {
          return JSON.stringify(submitResult, null, 2);
        }

        // Poll for completion
        const deadline = Date.now() + (this.config.timeout ?? DEFAULT_TIMEOUT);
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          const status = await this.request(`/retrieval/${retrievalId}/`);
          if (status.status === "completed") {
            return this.truncate(JSON.stringify(status, null, 2));
          }
          if (status.status === "failed" || status.status === "error") {
            return `Retrieval failed: ${JSON.stringify(status)}`;
          }
        }

        return `Retrieval timed out. Retrieval ID: ${retrievalId} — check with pageindex_status later.`;
      },
    };
  }

  private deleteDocumentTool(): ToolDef {
    return {
      name: "pageindex_delete",
      description: "Delete a PageIndex document and all associated data.",
      parameters: z.object({
        docId: z.string().describe("PageIndex document ID to delete"),
      }),
      execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
        await this.request(`/doc/${args.docId as string}/`, { method: "DELETE" });
        return `Document ${args.docId} deleted successfully.`;
      },
    };
  }
}
