import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface HttpConfig {
  /** Base URL prepended to relative paths. */
  baseUrl?: string;
  /** Default headers included in every request. */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Max response body characters to return (default 20000). */
  maxResponseSize?: number;
}

/**
 * HTTP Toolkit — make arbitrary HTTP requests from your agent.
 *
 * Supports GET, POST, PUT, PATCH, DELETE with configurable headers,
 * base URL, timeout, and response truncation.
 *
 * @example
 * ```ts
 * const http = new HttpToolkit({ baseUrl: "https://api.example.com", headers: { Authorization: "Bearer ..." } });
 * const agent = new Agent({ tools: [...http.getTools()] });
 * ```
 */
export class HttpToolkit extends Toolkit {
  readonly name = "http";
  private config: HttpConfig;

  constructor(config: HttpConfig = {}) {
    super();
    this.config = config;
  }

  private buildUrl(urlOrPath: string): string {
    if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) return urlOrPath;
    const base = this.config.baseUrl?.replace(/\/$/, "") ?? "";
    return `${base}/${urlOrPath.replace(/^\//, "")}`;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "http_request",
        description:
          "Make an HTTP request. Returns status code, response headers, and body. Supports GET, POST, PUT, PATCH, DELETE.",
        parameters: z.object({
          url: z.string().describe("URL or path (relative to baseUrl if configured)"),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
          headers: z.record(z.string()).optional().describe("Additional request headers"),
          body: z.string().optional().describe("Request body (typically JSON string)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const url = this.buildUrl(args.url as string);
          const method = (args.method as string) ?? "GET";
          const maxSize = this.config.maxResponseSize ?? 20_000;

          const headers: Record<string, string> = {
            ...this.config.headers,
            ...((args.headers as Record<string, string>) ?? {}),
          };

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.config.timeout ?? 30_000);

          try {
            const res = await fetch(url, {
              method,
              headers,
              body: args.body as string | undefined,
              signal: controller.signal,
            });

            const contentType = res.headers.get("content-type") ?? "";
            let body: string;

            if (contentType.includes("application/json")) {
              const json = await res.json();
              body = JSON.stringify(json, null, 2);
            } else {
              body = await res.text();
            }

            if (body.length > maxSize) {
              body = `${body.slice(0, maxSize)}\n...(truncated, ${body.length} total chars)`;
            }

            const respHeaders = [...res.headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join("\n");

            return `Status: ${res.status} ${res.statusText}\nHeaders:\n${respHeaders}\n\nBody:\n${body}`;
          } finally {
            clearTimeout(timer);
          }
        },
      },
    ];
  }
}
