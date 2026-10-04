import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { Agent } from "../../agent/agent.js";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage, StreamChunk } from "../../models/types.js";
import { summarizeVoiceTimings } from "../metrics.js";
import { voiceMigrationDiagnostics } from "../migrations.js";
import { AgentVoiceBrain } from "../streaming-pipeline.js";

describe("voice using a real Agent", () => {
  it("keeps shared policy, canonical heard history and identity without accumulating session memory", async () => {
    const observed: ChatMessage[][] = [];
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: vi.fn(),
      async *stream(messages): AsyncGenerator<StreamChunk> {
        observed.push(structuredClone(messages));
        if (messages.at(-1)?.role === "user") {
          yield { type: "thinking", text: "private reasoning" };
          yield { type: "tool_call_start", toolCall: { id: "call", name: "lookup" } };
          yield { type: "tool_call_delta", toolCallId: "call", argumentsDelta: "{}" };
          yield { type: "tool_call_end", toolCallId: "call" };
          yield { type: "finish", finishReason: "tool_calls", usage };
        } else {
          yield { type: "text", text: "Spoken answer" };
          yield { type: "finish", finishReason: "stop", usage };
        }
      },
    };
    const execute = vi.fn(async (_args, ctx) => `${ctx.userId}/${ctx.tenantId}`);
    const tool = { name: "lookup", description: "lookup", parameters: z.object({}), execute };
    const agent = new Agent({
      name: "voice-harness",
      register: false,
      model: provider,
      tools: [tool],
      executionPolicy: { decide: () => ({ action: "allow" }) },
    });
    const brain = new AgentVoiceBrain(agent, { tenantId: "tenant", userId: "user" });
    for (let n = 0; n < 2; n++) {
      const chunks = [];
      for await (const chunk of brain.respond(
        {
          sessionId: "stable",
          turnId: String(n),
          generationId: String(n),
          text: "Current",
          history: [
            { role: "user", content: "Earlier" },
            { role: "assistant", content: "Only heard prefix [interrupted]" },
            { role: "user", content: "Current" },
          ],
        },
        new AbortController().signal,
      ))
        chunks.push(chunk);
      expect(chunks).toEqual([{ type: "text", text: "Spoken answer" }]);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(observed[0].filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Earlier", "Current"]);
    expect(observed[2]).toEqual(observed[0]);
    expect(execute.mock.calls[0][1]).toMatchObject({ userId: "user", tenantId: "tenant" });
    const sessions = await (agent as any).fallbackSessionManager.listSessions();
    expect(sessions).toEqual([]);
  });
});
it("summarizes measured stages without inventing missing audio samples", () => {
  expect(
    summarizeVoiceTimings([
      { turnId: "a", durationMs: 20, firstTextMs: 3 },
      { turnId: "b", durationMs: 10, firstTextMs: 2, firstAudioMs: 5 },
    ]),
  ).toEqual({
    firstTextMs: { samples: 2, p50: 2, p95: 3 },
    firstAudioMs: { samples: 1, p50: 5, p95: 5 },
    durationMs: { samples: 2, p50: 10, p95: 20 },
  });
});
it("names exact migration dates without treating the undated TTS alias as removed", () => {
  expect(
    voiceMigrationDiagnostics({ transcriptionModel: "whisper-1", ttsModel: "gpt-4o-mini-tts", remotePrompt: true }).map(
      (d) => d.shutdownDate,
    ),
  ).toEqual(["2027-02-26", "2026-11-30"]);
});
