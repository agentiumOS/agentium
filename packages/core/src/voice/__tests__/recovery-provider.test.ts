import type { LiveConnectConfig, LiveServerMessage } from "@google/genai";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:module", async (original) => ({
  ...(await original<typeof import("node:module")>()),
  createRequire: () => (name: string) => {
    if (name !== "@google/genai") throw new Error(`Unexpected SDK load: ${name}`);
    return {
      Modality: { AUDIO: "AUDIO" },
      GoogleGenAI: class {
        live = { connect: fixture.connect };
      },
    };
  },
}));

import { GoogleLiveProvider } from "../providers/google-live.js";
import { OpenAIRealtimeProvider } from "../providers/openai-realtime.js";

type Connect = {
  model: string;
  config: LiveConnectConfig;
  callbacks: { onclose(): void; onmessage(message: LiveServerMessage): void };
};
afterEach(() => {
  vi.resetAllMocks();
});

it("maps optional Gemini handles to the installed SDK contract and emits false updates without a handle", async () => {
  const sdk = { close: vi.fn(), sendRealtimeInput: vi.fn() };
  let request!: Connect;
  fixture.connect.mockImplementation(async (options: Connect) => {
    request = options;
    return sdk;
  });
  const provider = new GoogleLiveProvider("fixture", { apiKey: "test-only" });
  const connection = await provider.connect({ sessionResumption: { handle: "trusted-owner-handle" } });
  expect(request.config.sessionResumption).toEqual({ handle: "trusted-owner-handle" });
  const resume = vi.fn();
  const audio = vi.fn();
  connection.on("session_resume", resume);
  connection.on("audio", audio);
  request.callbacks.onmessage({ text: undefined, data: undefined, sessionResumptionUpdate: { resumable: false } });
  expect(resume).toHaveBeenCalledWith({ handle: undefined, resumable: false });
  request.callbacks.onclose();
  request.callbacks.onmessage({
    text: undefined,
    data: undefined,
    serverContent: { modelTurn: { parts: [{ inlineData: { data: "AQA=" } }] } },
  });
  connection.commitAudio();
  expect(audio).not.toHaveBeenCalled();
  expect(sdk.sendRealtimeInput).not.toHaveBeenCalled();
  await connection.close();
});

it("cancels a pending Gemini connect immediately and closes a late SDK session", async () => {
  let complete!: (session: { close(): void }) => void;
  fixture.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = new GoogleLiveProvider("fixture", { apiKey: "test-only" }).connect({ signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow(/cancelled/);
  const close = vi.fn();
  complete({ close });
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it("closes an already established Gemini SDK session on abort", async () => {
  const sdk = { close: vi.fn() };
  fixture.connect.mockResolvedValue(sdk);
  const controller = new AbortController();
  const connection = await new GoogleLiveProvider("fixture", { apiKey: "test-only" }).connect({
    signal: controller.signal,
  });
  controller.abort();
  await connection.close();
  expect(sdk.close).toHaveBeenCalledOnce();
});

it("rejects an OpenAI resumption token before SDK or network access", async () => {
  await expect(
    new OpenAIRealtimeProvider().connect({ sessionResumption: { handle: "not-an-openai-token" } }),
  ).rejects.toThrow(/do not support/);
});
