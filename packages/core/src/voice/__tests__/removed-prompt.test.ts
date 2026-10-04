import { expect, it, vi } from "vitest";
import { GoogleLiveProvider } from "../providers/google-live.js";
import { OpenAIRealtimeProvider } from "../providers/openai-realtime.js";
import type { RealtimeSessionConfig, VoiceAgentConfig } from "../types.js";
import { VoiceAgent } from "../voice-agent.js";

it("rejects legacy JavaScript prompt configuration before VoiceAgent initializes services", () => {
  const memory = vi.fn(() => {
    throw new Error("Memory must not be initialized");
  });
  for (const prompt of [{ id: "legacy" }, null, false, "legacy"]) {
    const config = {
      name: "invalid",
      prompt,
      get memory() {
        return memory();
      },
    } as unknown as VoiceAgentConfig;
    expect(() => new VoiceAgent(config)).toThrow(/app-owned instructions/);
  }
  expect(memory).not.toHaveBeenCalled();
});

it("rejects direct provider prompt calls before credential access or provider work", async () => {
  const credentials = vi.fn(() => {
    throw new Error("Credentials must not be read");
  });
  const config = {
    prompt: { id: "legacy" },
    get apiKey() {
      return credentials();
    },
  } as unknown as RealtimeSessionConfig;
  await expect(new OpenAIRealtimeProvider().connect(config)).rejects.toThrow(/app-owned instructions/);
  await expect(new GoogleLiveProvider().connect(config)).rejects.toThrow(/app-owned instructions/);
  expect(credentials).not.toHaveBeenCalled();
});
