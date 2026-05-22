import type { Agent } from "@agentium/core";

/**
 * Vercel AI SDK UI Message Stream adapter.
 *
 * Converts the chunks emitted by `agent.stream(...)` into the line-delimited
 * JSON protocol consumed by Vercel's `useChat` / `createAgentUIStreamResponse`.
 *
 * Spec: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */

export interface AgentUIStreamOptions {
  /** sessionId forwarded to `agent.run` / `agent.stream`. */
  sessionId?: string;
  /** userId forwarded to `agent.run` / `agent.stream`. */
  userId?: string;
  /** Optional per-request API key override. */
  apiKey?: string;
  /** Optional abort signal to cancel the run. */
  signal?: AbortSignal;
}

interface AgentLikeChunk {
  type?: string;
  text?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string | { message?: string };
  reasoning?: string;
  thinking?: string;
}

interface AgentLike {
  stream(
    input: string,
    opts?: { sessionId?: string; userId?: string; apiKey?: string; signal?: AbortSignal },
  ): AsyncIterable<AgentLikeChunk>;
}

function ssePayload(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * Render an `agent.stream()` source as a Vercel-compatible UI message stream.
 *
 * The returned `ReadableStream<Uint8Array>` can be wrapped in a `Response`
 * (web / edge / fetch) or piped to a Node `ServerResponse`.
 */
export function agentUIStream(
  agent: Agent | AgentLike,
  input: string,
  options: AgentUIStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let textPartId = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(ssePayload({ type: "start", messageId })));

        let currentTextId: string | null = null;
        for await (const chunk of (agent as AgentLike).stream(input, {
          sessionId: options.sessionId,
          userId: options.userId,
          apiKey: options.apiKey,
          signal: options.signal,
        })) {
          const t = chunk.type;

          if (t === "text" || t === "text-delta") {
            const delta = chunk.delta ?? chunk.text ?? "";
            if (!delta) continue;
            if (!currentTextId) {
              currentTextId = `text-${++textPartId}`;
              controller.enqueue(encoder.encode(ssePayload({ type: "text-start", id: currentTextId })));
            }
            controller.enqueue(encoder.encode(ssePayload({ type: "text-delta", id: currentTextId, textDelta: delta })));
          } else if (t === "reasoning" || t === "thinking") {
            const r = chunk.reasoning ?? chunk.thinking ?? chunk.delta ?? chunk.text ?? "";
            if (r) {
              controller.enqueue(
                encoder.encode(ssePayload({ type: "reasoning-delta", id: messageId, reasoningDelta: r })),
              );
            }
          } else if (t === "tool.call" || t === "tool-call" || t === "tool-input-start") {
            if (currentTextId) {
              controller.enqueue(encoder.encode(ssePayload({ type: "text-end", id: currentTextId })));
              currentTextId = null;
            }
            controller.enqueue(
              encoder.encode(
                ssePayload({
                  type: "tool-input-start",
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                }),
              ),
            );
            const args = chunk.arguments ?? chunk.args ?? chunk.input;
            if (args !== undefined) {
              controller.enqueue(
                encoder.encode(
                  ssePayload({
                    type: "tool-input-available",
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    input: args,
                  }),
                ),
              );
            }
          } else if (t === "tool.result" || t === "tool-result" || t === "tool-output-available") {
            controller.enqueue(
              encoder.encode(
                ssePayload({
                  type: "tool-output-available",
                  toolCallId: chunk.toolCallId,
                  output: chunk.output ?? chunk.result,
                }),
              ),
            );
          } else if (t === "error") {
            const errText = typeof chunk.error === "string" ? chunk.error : (chunk.error?.message ?? "unknown error");
            controller.enqueue(encoder.encode(ssePayload({ type: "error", errorText: errText })));
          } else if (t === "finish" || t === "done" || t === "stream.end") {
            if (currentTextId) {
              controller.enqueue(encoder.encode(ssePayload({ type: "text-end", id: currentTextId })));
              currentTextId = null;
            }
            controller.enqueue(
              encoder.encode(
                ssePayload({
                  type: "finish-step",
                  finishReason: chunk.finishReason ?? "stop",
                  usage: chunk.usage,
                }),
              ),
            );
          }
        }

        if (currentTextId) {
          controller.enqueue(encoder.encode(ssePayload({ type: "text-end", id: currentTextId })));
        }
        controller.enqueue(encoder.encode(ssePayload({ type: "finish" })));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        controller.enqueue(encoder.encode(ssePayload({ type: "error", errorText: err?.message ?? String(err) })));
        controller.close();
      }
    },
  });
}

/**
 * Create a `Response` whose body streams Vercel UI messages. Use as the return
 * value of a Web / Edge / Next.js Route Handler.
 *
 * @example
 * ```ts
 * import { createAgentUIStreamResponse } from "@agentium/transport";
 *
 * export async function POST(req: Request) {
 *   const { input, sessionId } = await req.json();
 *   return createAgentUIStreamResponse(agent, input, { sessionId });
 * }
 * ```
 */
export function createAgentUIStreamResponse(
  agent: Agent | AgentLike,
  input: string,
  options: AgentUIStreamOptions = {},
): Response {
  const body = agentUIStream(agent, input, options);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}

/**
 * Pipe a Vercel UI message stream into a Node `ServerResponse` (Express style).
 */
export async function pipeAgentUIStreamToResponse(
  agent: Agent | AgentLike,
  input: string,
  res: any /* Express-like response */,
  options: AgentUIStreamOptions = {},
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
  });
  const stream = agentUIStream(agent, input, options);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}
