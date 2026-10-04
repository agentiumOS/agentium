/** Compatibility transports still enforce local cancellation and bounded SSE framing. */
export function legacyEndpoint(url: string, timeoutMs: number): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Invalid remote endpoint URL");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid remote request timeout");
  return parsed.href.replace(/\/$/, "");
}
export function legacySignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  signal?.throwIfAborted();
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export async function* readLegacySSE(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let eventBytes = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        eventBytes += Buffer.byteLength(line);
        if (eventBytes > 1024 * 1024) throw new Error("Remote SSE event exceeds 1 MiB");
        if (line === "") {
          const payload = data.join("\n");
          data = [];
          eventBytes = 0;
          if (payload === "[DONE]") return;
          if (payload) yield JSON.parse(payload);
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (eventBytes + Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("Remote SSE event exceeds 1 MiB");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
