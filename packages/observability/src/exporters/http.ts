import { setTimeout as delay } from "node:timers/promises";
import { positive } from "../safety.js";
export interface HttpExportOptions {
  timeoutMs?: number;
  maxRetries?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}
export async function postTelemetry(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: HttpExportOptions = {},
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, any> }> {
  const timeout = positive(options.timeoutMs ?? 10000, "timeoutMs");
  const maxBytes = positive(options.maxRequestBytes ?? 4_194_304, "maxRequestBytes");
  const responseLimit = positive(options.maxResponseBytes ?? 65536, "maxResponseBytes");
  const retries = options.maxRetries ?? 2;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new TypeError("maxRetries must be 0..5");
  if (Buffer.byteLength(body) > maxBytes) throw new Error("Telemetry payload exceeds byte limit");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);
  const deadline = Date.now() + timeout;
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      combined.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body,
          signal: combined,
          redirect: "error",
        });
      } catch {
        if (combined.aborted || attempt === retries) throw new Error("Telemetry request failed or timed out");
        await delay(Math.min(1000, 100 * 2 ** attempt) * (0.8 + Math.random() * 0.4), undefined, { signal: combined });
        continue;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < retries) {
        const retryAfter = response.headers.get("retry-after");
        const wait = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now())
          : 100 * 2 ** attempt * (0.8 + Math.random() * 0.4);
        await response.body?.cancel();
        if (!Number.isFinite(wait) || wait >= deadline - Date.now())
          throw new Error("Telemetry retry exceeds deadline");
        await delay(wait, undefined, { signal: combined });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Telemetry HTTP status ${response.status}`);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader)
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > responseLimit) {
              await reader.cancel();
              throw new Error("Telemetry response exceeds byte limit");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = text.trim() ? JSON.parse(text) : {};
      } catch {
        throw new Error("Invalid telemetry response JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid telemetry response shape");
      return { status: response.status, body: parsed as Record<string, any> };
    }
    throw new Error("Telemetry retries exhausted");
  } finally {
    clearTimeout(timer);
  }
}
export function endpointURL(value: string): string {
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search
  )
    throw new Error("Telemetry endpoint must be an HTTP(S) URL without credentials/query/fragment");
  return parsed.toString().replace(/\/$/, "");
}
