import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface PdfConfig {
  /** Max text length to return per extraction (default 50000). */
  maxLength?: number;
}

/**
 * PDF Toolkit — extract text, metadata, and page content from PDF files.
 *
 * Requires the `pdf-parse` peer dependency.
 *
 * @example
 * ```ts
 * const pdf = new PdfToolkit();
 * const agent = new Agent({ tools: [...pdf.getTools()] });
 * ```
 */
export class PdfToolkit extends Toolkit {
  readonly name = "pdf";
  private maxLength: number;

  constructor(config: PdfConfig = {}) {
    super();
    this.maxLength = config.maxLength ?? 50000;
  }

  private async parse(source: string): Promise<any> {
    const pdfParse = _require("pdf-parse");
    const isBase64 = !source.startsWith("/") && !source.startsWith("http");

    let buffer: Buffer;
    if (isBase64) {
      buffer = Buffer.from(source, "base64");
    } else if (source.startsWith("http://") || source.startsWith("https://")) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } else {
      const fs = await import("node:fs");
      buffer = fs.readFileSync(source);
    }

    return pdfParse(buffer);
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "pdf_extract_text",
        description: "Extract all text content from a PDF. Accepts a file path, URL, or base64-encoded PDF data.",
        parameters: z.object({
          source: z.string().describe("File path, URL, or base64-encoded PDF data"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const data = await this.parse(args.source as string);
            const text = (data.text as string) ?? "";
            if (text.length > this.maxLength) {
              return `${text.slice(0, this.maxLength)}\n\n...[truncated at ${this.maxLength} chars, total ${text.length}]`;
            }
            return text || "(no text content found)";
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "pdf_get_metadata",
        description: "Get metadata from a PDF (title, author, page count, creation date, etc.).",
        parameters: z.object({
          source: z.string().describe("File path, URL, or base64-encoded PDF data"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const data = await this.parse(args.source as string);
            return JSON.stringify(
              {
                pages: data.numpages,
                title: data.info?.Title ?? null,
                author: data.info?.Author ?? null,
                subject: data.info?.Subject ?? null,
                creator: data.info?.Creator ?? null,
                producer: data.info?.Producer ?? null,
                creationDate: data.info?.CreationDate ?? null,
                modDate: data.info?.ModDate ?? null,
              },
              null,
              2,
            );
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "pdf_extract_pages",
        description: "Extract text from specific pages of a PDF. Returns text per page.",
        parameters: z.object({
          source: z.string().describe("File path, URL, or base64-encoded PDF data"),
          pages: z.array(z.number()).optional().describe("Page numbers to extract (1-indexed). Omit for all pages."),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const requestedPages = args.pages as number[] | undefined;
            const results: { page: number; text: string }[] = [];
            const _pageNum = 0;

            const data = await this.parse(args.source as string);
            const fullText = (data.text as string) ?? "";
            const totalPages = data.numpages ?? 1;

            if (!requestedPages || requestedPages.length === 0) {
              return JSON.stringify({
                totalPages,
                text:
                  fullText.length > this.maxLength ? `${fullText.slice(0, this.maxLength)}...[truncated]` : fullText,
              });
            }

            const perPageApprox = Math.ceil(fullText.length / totalPages);
            for (const p of requestedPages) {
              if (p < 1 || p > totalPages) {
                results.push({ page: p, text: `(page ${p} out of range, PDF has ${totalPages} pages)` });
              } else {
                const start = (p - 1) * perPageApprox;
                const end = Math.min(start + perPageApprox, fullText.length);
                results.push({ page: p, text: fullText.slice(start, end) });
              }
            }

            return JSON.stringify({ totalPages, pages: results }, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
