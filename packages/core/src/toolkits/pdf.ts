import { createRequire } from "node:module";
import { z } from "zod/v3";
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
    if (!Number.isSafeInteger(this.maxLength) || this.maxLength < 1)
      throw new Error("PdfToolkit maxLength must be a positive integer");
  }

  private async parse(source: string, ctx: RunContext, pages?: number[], metadata = false): Promise<any> {
    const { PDFParse } = _require("pdf-parse");
    if (typeof PDFParse !== "function")
      throw new Error("PdfToolkit requires pdf-parse ^2.4.5; v1 function API is no longer supported");
    ctx.signal?.throwIfAborted();
    let buffer: Buffer;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await fetch(source, { signal: ctx.signal });
      if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
    } else if (source.startsWith("/")) {
      const { readFile } = await import("node:fs/promises");
      buffer = await readFile(source, { signal: ctx.signal });
    } else buffer = Buffer.from(source, "base64");
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const info = await parser.getInfo();
      if (metadata) return { numpages: info.total, info: info.info };
      if (pages?.some((page) => !Number.isSafeInteger(page) || page < 1 || page > info.total))
        throw new Error("Requested page is outside the PDF page range");
      ctx.signal?.throwIfAborted();
      const text = await parser.getText(pages?.length ? { partial: pages } : {});
      ctx.signal?.throwIfAborted();
      return {
        numpages: text.total,
        info: info.info,
        text: text.text,
        pages: text.pages.map((page: any) => ({ page: page.num, text: page.text })),
      };
    } finally {
      await parser.destroy();
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "pdf_extract_text",
        description: "Extract all text content from a PDF. Accepts a file path, URL, or base64-encoded PDF data.",
        parameters: z.object({
          source: z.string().describe("File path, URL, or base64-encoded PDF data"),
        }),
        execute: async (args: Record<string, unknown>, ctx: RunContext): Promise<string> => {
          try {
            const data = await this.parse(args.source as string, ctx);
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
        execute: async (args: Record<string, unknown>, ctx: RunContext): Promise<string> => {
          try {
            const data = await this.parse(args.source as string, ctx, undefined, true);
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
          pages: z
            .array(z.number().int().positive())
            .optional()
            .describe("Page numbers to extract (1-indexed). Omit for all pages."),
        }),
        execute: async (args: Record<string, unknown>, ctx: RunContext): Promise<string> => {
          try {
            const requestedPages = args.pages as number[] | undefined;
            const data = await this.parse(args.source as string, ctx, requestedPages);
            let remaining = this.maxLength;
            const pages = data.pages.map((page: { page: number; text: string }) => {
              const text = page.text.slice(0, remaining);
              remaining -= text.length;
              return { ...page, text, ...(text.length < page.text.length ? { truncated: true } : {}) };
            });
            return JSON.stringify({ totalPages: data.numpages, pages }, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
