import { describe, expect, it } from "vitest";
import { agentUIStream, createAgentUIStreamResponse } from "../express/ui-stream.js";

function makeAgent(chunks: any[]) {
  return {
    async *stream(_input: string) {
      for (const c of chunks) yield c;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

function parsePayloads(raw: string): any[] {
  const lines = raw.split("\n").filter((l) => l.startsWith("data: ") && l.trim() !== "data: [DONE]");
  return lines.map((l) => JSON.parse(l.slice(6)));
}

describe("agentUIStream (Vercel UI Message Stream adapter)", () => {
  it("emits start, text deltas, and finish", async () => {
    const agent = makeAgent([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world!" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
    ]);

    const raw = await collect(agentUIStream(agent as any, "hi"));
    const payloads = parsePayloads(raw);

    expect(payloads[0]).toMatchObject({ type: "start" });
    expect(payloads.some((p) => p.type === "text-start")).toBe(true);
    expect(payloads.filter((p) => p.type === "text-delta").length).toBe(2);
    expect(payloads.find((p) => p.type === "finish-step")).toMatchObject({ finishReason: "stop" });
    expect(payloads[payloads.length - 1]).toMatchObject({ type: "finish" });
  });

  it("converts tool.call and tool.result chunks", async () => {
    const agent = makeAgent([
      { type: "tool.call", toolCallId: "c1", toolName: "weather", arguments: { city: "Tokyo" } },
      { type: "tool.result", toolCallId: "c1", result: "sunny 22C" },
    ]);

    const raw = await collect(agentUIStream(agent as any, "weather?"));
    const payloads = parsePayloads(raw);

    expect(payloads.find((p) => p.type === "tool-input-start")).toMatchObject({
      toolCallId: "c1",
      toolName: "weather",
    });
    expect(payloads.find((p) => p.type === "tool-input-available")).toMatchObject({
      toolCallId: "c1",
      input: { city: "Tokyo" },
    });
    expect(payloads.find((p) => p.type === "tool-output-available")).toMatchObject({
      toolCallId: "c1",
      output: "sunny 22C",
    });
  });

  it("converts reasoning chunks", async () => {
    const agent = makeAgent([{ type: "reasoning", reasoning: "thinking..." }]);
    const raw = await collect(agentUIStream(agent as any, "x"));
    const payloads = parsePayloads(raw);
    expect(payloads.find((p) => p.type === "reasoning-delta")).toMatchObject({ reasoningDelta: "thinking..." });
  });

  it("handles error chunks", async () => {
    const agent = makeAgent([{ type: "error", error: "boom" }]);
    const raw = await collect(agentUIStream(agent as any, "x"));
    const payloads = parsePayloads(raw);
    expect(payloads.find((p) => p.type === "error")).toMatchObject({ errorText: "boom" });
  });

  it("catches stream errors", async () => {
    const agent = {
      async *stream(_: string) {
        yield { type: "text", text: "ok" };
        throw new Error("stream failed");
      },
    };
    const raw = await collect(agentUIStream(agent as any, "x"));
    const payloads = parsePayloads(raw);
    expect(payloads.find((p) => p.type === "error")?.errorText).toBe("stream failed");
  });

  it("createAgentUIStreamResponse returns a Response with right headers", async () => {
    const agent = makeAgent([{ type: "text", text: "hi" }]);
    const res = createAgentUIStreamResponse(agent as any, "input");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("closes any open text-part on finish", async () => {
    const agent = makeAgent([{ type: "text", text: "open" }]);
    const raw = await collect(agentUIStream(agent as any, "x"));
    const payloads = parsePayloads(raw);
    const idx = payloads.findIndex((p) => p.type === "text-end");
    expect(idx).toBeGreaterThan(-1);
  });
});
