import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeSession, turnDetectionToGa } from "../openai-session.js";

describe("turnDetectionToGa", () => {
  it("defaults to semantic_vad", () => {
    expect(turnDetectionToGa(undefined)).toMatchObject({ type: "semantic_vad", eagerness: "low" });
  });

  it("maps server_vad idle timeout", () => {
    expect(turnDetectionToGa({ type: "server_vad", idleTimeoutMs: 8000 })).toMatchObject({
      type: "server_vad",
      idle_timeout_ms: 8000,
    });
  });

  it("allows push-to-talk (null)", () => {
    expect(turnDetectionToGa(null)).toBeNull();
  });
});

describe("buildOpenAIRealtimeSession", () => {
  it("emits GA session.type and nested audio", () => {
    const session = buildOpenAIRealtimeSession("gpt-realtime-2.1", {
      instructions: "Be brief.",
      voice: "marin",
      reasoningEffort: "low",
      tools: [{ name: "lookup", description: "Look up", parameters: { type: "object" } }],
      mcpServers: [{ serverLabel: "crm", serverUrl: "https://mcp.example.com" }],
      prompt: { id: "pmpt_1", version: "2" },
      noiseReduction: { type: "near_field" },
    });
    expect(session.type).toBe("realtime");
    expect(session.model).toBe("gpt-realtime-2.1");
    expect(session.output_modalities).toEqual(["audio"]);
    expect((session.audio as any).output.voice).toBe("marin");
    expect((session.audio as any).input.noise_reduction).toEqual({ type: "near_field" });
    expect(session.reasoning).toEqual({ effort: "low" });
    expect(session.prompt).toMatchObject({ id: "pmpt_1", version: "2" });
    const tools = session.tools as any[];
    expect(tools.some((t) => t.type === "function" && t.name === "lookup")).toBe(true);
    expect(tools.some((t) => t.type === "mcp" && t.server_label === "crm")).toBe(true);
  });

  it("appends translation instructions", () => {
    const session = buildOpenAIRealtimeSession("gpt-realtime-2.1", {
      instructions: "Helpful.",
      translation: { targetLanguage: "Hindi" },
    });
    expect(String(session.instructions)).toContain("Hindi");
  });
});
