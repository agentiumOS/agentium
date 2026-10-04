import { expect, it, vi } from "vitest";
import { BoundedVoiceQueue } from "../bounded-queue.js";
import { requireVoiceLiveValidation, summarizeVoicePlayback, validateLiveRecognition } from "../live-validation.js";
import type { SpeechRecognizer, TranscriptEvent } from "../speech-types.js";

const gate = {
  enabled: true,
  accountLabel: "approved-test-project",
  allowedProviders: ["fixture"],
  maxAudioSeconds: 1,
  maxCases: 3,
};
const format = { encoding: "pcm_s16le" as const, sampleRateHz: 24000, channels: 1 as const };
const testCase = {
  id: "hi-en",
  languages: ["hi", "en"],
  scenario: "code-switching" as const,
  frames: [{ ...format, bytes: new Uint8Array(480), sequence: 0, generationId: "g", turnId: "t" }],
  requiredPhrases: ["order"],
};
it("rejects unapproved accounts/providers and budget bypasses before constructing providers", async () => {
  const createRecognizer = vi.fn();
  await expect(
    validateLiveRecognition({
      gate: { ...gate, enabled: false },
      provider: "fixture",
      cases: [testCase],
      createRecognizer,
    }),
  ).rejects.toThrow(/requires/);
  await expect(
    validateLiveRecognition({ gate, provider: "paid-other", cases: [testCase], createRecognizer }),
  ).rejects.toThrow(/requires/);
  await expect(
    validateLiveRecognition({
      gate: { ...gate, maxAudioSeconds: 0.001 },
      provider: "fixture",
      cases: [testCase],
      createRecognizer,
    }),
  ).rejects.toThrow(/budget/);
  await expect(
    validateLiveRecognition({
      gate,
      provider: "fixture",
      cases: [{ ...testCase, frames: [{ ...testCase.frames[0], sampleRateHz: NaN }] }],
      createRecognizer,
    }),
  ).rejects.toThrow(/format/);
  expect(() => requireVoiceLiveValidation(gate, "fixture", 1, NaN)).toThrow(/budget/);
  expect(createRecognizer).not.toHaveBeenCalled();
});
it("paces each case through a fresh recognizer, reports task success and closes connections", async () => {
  const close = vi.fn();
  const open = vi.fn();
  const factory = (): SpeechRecognizer => ({
    capabilities: { provider: "fixture", formats: [format], partials: true, manualCommit: true, maturity: "stable" },
    async open() {
      open();
      const queue = new BoundedVoiceQueue<TranscriptEvent>();
      return {
        events: queue,
        sendAudio: async () => {},
        flush: async () =>
          queue.push(
            { kind: "final", role: "user", segmentId: "segment", text: "मेरा order", languages: ["hi", "en"] },
            20,
          ),
        close: async () => {
          close();
          queue.close();
        },
      };
    },
  });
  const report = await validateLiveRecognition({
    gate,
    provider: "fixture",
    cases: [testCase, { ...testCase, id: "reconnect", scenario: "reconnect" }],
    createRecognizer: factory,
  });
  expect(report.results).toHaveLength(2);
  expect(report.results[0]).toMatchObject({ taskSuccess: true, detectedLanguages: ["hi", "en"], audioSeconds: 0.01 });
  expect(report.finalAfterCommitMs.p50).toBeGreaterThanOrEqual(0);
  expect(open).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
it("does not invent audible latency or success from an unmeasured case", () => {
  const report = summarizeVoicePlayback([{ caseId: "unknown", languages: ["en"], scenario: "baseline" }]);
  expect(report.firstAudibleMs).toEqual({ samples: 0 });
  expect(report.taskSuccess).toEqual({ samples: 0 });
  expect(() =>
    summarizeVoicePlayback([{ caseId: "bad", languages: ["hi"], scenario: "interruption", firstAudibleMs: -1 }]),
  ).toThrow(/measurement/);
});
