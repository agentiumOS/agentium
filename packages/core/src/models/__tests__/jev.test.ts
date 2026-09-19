import { describe, expect, it, vi } from "vitest";
import { choice, noul } from "../jev-sdk.js";
import { JevProvider } from "../providers/jev.js";
import { jev, modelRegistry } from "../registry.js";

function answersResult(answers: Record<string, unknown>, usage = { input_tokens: 12, output_tokens: 0 }) {
  return { answers, model: "jev-1.13.0", usage };
}

function mockClient(answers: Record<string, unknown> | ((req: any) => Record<string, unknown>)) {
  return {
    systemOne: vi.fn(async (req: any) => {
      const a = typeof answers === "function" ? answers(req) : answers;
      return answersResult(a);
    }),
  };
}

describe("jev() factory", () => {
  it("registers on the default registry", () => {
    expect(modelRegistry.has("jev")).toBe(true);
  });

  it("returns a Jev provider with the given model id", () => {
    const provider = jev("jev-1.13.0");
    expect(provider.providerId).toBe("jev");
    expect(provider.modelId).toBe("jev-1.13.0");
  });

  it("defaults to jev-latest", () => {
    expect(jev().modelId).toBe("jev-latest");
  });
});

describe("JevProvider", () => {
  it("returns JSON answers for constructor questions", async () => {
    const provider = new JevProvider("jev-latest", {
      questions: { urgent: noul("Is this urgent?") },
    });
    const client = mockClient({ urgent: { type: "noul", noul: 0.91 } });
    provider.client = client;

    const result = await provider.generate([{ role: "user", content: "Charge me twice??" }]);

    expect(result.finishReason).toBe("stop");
    expect(JSON.parse(result.message.content as string)).toEqual({ urgent: { type: "noul", noul: 0.91 } });
    expect(result.usage.promptTokens).toBe(12);
    expect(result.usage.completionTokens).toBe(0);
    expect(client.systemOne).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "jev-latest",
        state: "Charge me twice??",
        questions: expect.objectContaining({ urgent: expect.anything() }),
      }),
    );
    expect(result.raw).toEqual(expect.objectContaining({ model: "jev-1.13.0" }));
  });

  it("parses JSON user text as state", async () => {
    const provider = new JevProvider("jev-latest", { questions: { x: noul("x?") } });
    const client = mockClient({ x: { type: "noul", noul: 0.2 } });
    provider.client = client;

    await provider.generate([{ role: "user", content: '{"ticket":"dup charge"}' }]);
    expect(client.systemOne.mock.calls[0][0].state).toEqual({ ticket: "dup charge" });
  });

  it("packs prior turns into history when state is plain text", async () => {
    const provider = new JevProvider("jev-latest", { questions: { x: noul("x?") } });
    const client = mockClient({ x: { type: "noul", noul: 1 } });
    provider.client = client;

    await provider.generate([
      { role: "system", content: "triage" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "now this" },
    ]);

    expect(client.systemOne.mock.calls[0][0].state).toEqual({
      input: "now this",
      history: [
        { role: "system", content: "triage" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "ok" },
      ],
    });
  });

  it("emits tool_calls when __tool__ names a registered tool", async () => {
    const provider = new JevProvider("jev-latest");
    const client = mockClient({ __tool__: { type: "choice", choice: "escalate" } });
    provider.client = client;

    const result = await provider.generate([{ role: "user", content: "page someone" }], {
      tools: [
        { name: "escalate", description: "Escalate to oncall", parameters: { type: "object" } },
        { name: "refund", description: "Issue a refund", parameters: { type: "object" } },
      ],
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.message.toolCalls).toEqual([{ id: "call_jev_escalate", name: "escalate", arguments: {} }]);
    expect(client.systemOne.mock.calls[0][0].questions.__tool__).toBeDefined();
  });

  it("emits tool_calls when a constructor choice matches a tool name", async () => {
    const provider = new JevProvider("jev-latest", {
      questions: {
        action: choice("What should we do?", { escalate: null, queue: null }),
      },
    });
    const client = mockClient({ action: { type: "choice", choice: "escalate" } });
    provider.client = client;

    const result = await provider.generate([{ role: "user", content: "this is on fire" }], {
      tools: [{ name: "escalate", description: "Escalate", parameters: { type: "object" } }],
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.message.toolCalls?.[0].name).toBe("escalate");
    expect(client.systemOne.mock.calls[0][0].questions.action).toBeDefined();
    expect(client.systemOne.mock.calls[0][0].questions.__tool__).toBeUndefined();
  });

  it("does not emit tool_calls when __tool__ is none", async () => {
    const provider = new JevProvider("jev-latest");
    provider.client = mockClient({ __tool__: { type: "choice", choice: "none" } });

    const result = await provider.generate([{ role: "user", content: "just thinking" }], {
      tools: [{ name: "escalate", description: "Escalate", parameters: { type: "object" } }],
    });

    expect(result.finishReason).toBe("stop");
    expect(result.message.toolCalls).toBeUndefined();
  });

  it("uses per-request questions over constructor questions", async () => {
    const provider = new JevProvider("jev-latest", {
      questions: { stale: noul("stale?") },
    });
    const client = mockClient({ team: { type: "choice", choice: "billing" } });
    provider.client = client;

    await provider.generate([{ role: "user", content: "charged twice" }], {
      questions: { team: choice("Which team?", { billing: null, tech: null }) },
    });

    const sent = client.systemOne.mock.calls[0][0].questions;
    expect(sent.team).toBeDefined();
    expect(sent.stale).toBeUndefined();
  });

  it("throws when there are no questions, schema, or tools", async () => {
    const provider = new JevProvider("jev-latest");
    provider.client = mockClient({});
    await expect(provider.generate([{ role: "user", content: "hi" }])).rejects.toThrow(/nothing to ask/i);
  });

  it("derives questions from a JSON schema and flattens answers", async () => {
    const provider = new JevProvider("jev-latest");
    const client = mockClient({
      category: { type: "choice", choice: "billing" },
      urgent: { type: "noul", noul: 0.8 },
      severity: { type: "score", score: 2 },
    });
    provider.client = client;

    const result = await provider.generate([{ role: "user", content: "charged twice" }], {
      responseFormat: {
        type: "json_schema",
        name: "structured_response",
        schema: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["billing", "technical", "other"], description: "Ticket topic" },
            urgent: { type: "boolean", description: "Needs a reply in an hour" },
            severity: { type: "integer", minimum: 1, maximum: 5, description: "Impact" },
          },
        },
      },
    });

    expect(JSON.parse(result.message.content as string)).toEqual({
      category: "billing",
      urgent: true,
      severity: 3,
    });
  });

  it("rounds a fractional score when flattening structuredOutput", async () => {
    const provider = new JevProvider("jev-latest");
    provider.client = mockClient({
      severity: { type: "score", score: 2.46 },
    });

    const result = await provider.generate([{ role: "user", content: "charged twice" }], {
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            severity: { type: "integer", minimum: 1, maximum: 5, description: "Impact" },
          },
        },
      },
    });

    expect(JSON.parse(result.message.content as string)).toEqual({ severity: 3 });
  });

  it("throws on unmappable structuredOutput fields", async () => {
    const provider = new JevProvider("jev-latest");
    provider.client = mockClient({});
    await expect(
      provider.generate([{ role: "user", content: "hi" }], {
        responseFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { email: { type: "string" } } },
        },
      }),
    ).rejects.toThrow(/cannot map "email"/);
  });

  it("streams one text chunk then finish", async () => {
    const provider = new JevProvider("jev-latest", { questions: { ok: noul("ok?") } });
    provider.client = mockClient({ ok: { type: "noul", noul: 0.4 } });

    const chunks: unknown[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "x" }])) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: "text", text: JSON.stringify({ ok: { type: "noul", noul: 0.4 } }) });
    expect(chunks[1]).toEqual(
      expect.objectContaining({
        type: "finish",
        finishReason: "stop",
        usage: expect.objectContaining({ promptTokens: 12 }),
      }),
    );
    expect(chunks).toHaveLength(2);
  });

  it("streams tool_call start/end when a tool is chosen", async () => {
    const provider = new JevProvider("jev-latest");
    provider.client = mockClient({ __tool__: { type: "choice", choice: "refund" } });

    const types: string[] = [];
    for await (const chunk of provider.stream([{ role: "user", content: "refund me" }], {
      tools: [{ name: "refund", description: "Refund", parameters: { type: "object" } }],
    })) {
      types.push(chunk.type);
    }
    expect(types).toEqual(["text", "tool_call_start", "tool_call_end", "finish"]);
  });
});
