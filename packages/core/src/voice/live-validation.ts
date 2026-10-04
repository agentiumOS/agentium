import { setTimeout as sleep } from "node:timers/promises";
import { type AudioFrame, type SpeechRecognizer, type TranscriptEvent, validateAudioFrame } from "./speech-types.js";
export interface VoiceLiveValidationGate {
  enabled: boolean;
  /** Non-secret label identifying the explicitly approved test account/project. */
  accountLabel: string;
  allowedProviders: readonly string[];
  maxAudioSeconds: number;
  maxCases: number;
}
export interface VoiceRecognitionCase {
  id: string;
  languages: readonly string[];
  scenario: "baseline" | "code-switching" | "reconnect";
  /** Raw provider-compatible audio; do not include WAV/container headers. */
  frames: readonly AudioFrame[];
  /** Domain/task success criteria, not an assertion of acoustic quality. */
  requiredPhrases?: readonly string[];
}
export interface VoiceRecognitionResult {
  caseId: string;
  languages: readonly string[];
  scenario: VoiceRecognitionCase["scenario"];
  transcript: string;
  detectedLanguages?: readonly string[];
  audioSeconds: number;
  finalAfterCommitMs: number;
  taskSuccess: boolean | null;
}
/** Explicit gate checked before constructing any provider or opening a connection. */
export function requireVoiceLiveValidation(
  gate: VoiceLiveValidationGate,
  provider: string,
  cases: number,
  audioSeconds: number,
): void {
  if (gate.enabled !== true || !gate.accountLabel?.trim() || !gate.allowedProviders?.includes(provider))
    throw new Error("Live voice validation requires an enabled gate, approved account label and provider allowlist");
  if (
    !Number.isSafeInteger(gate.maxCases) ||
    gate.maxCases <= 0 ||
    !Number.isFinite(gate.maxAudioSeconds) ||
    gate.maxAudioSeconds <= 0 ||
    !Number.isSafeInteger(cases) ||
    cases <= 0 ||
    !Number.isFinite(audioSeconds) ||
    audioSeconds < 0 ||
    cases > gate.maxCases ||
    audioSeconds > gate.maxAudioSeconds
  )
    throw new Error("Live voice validation exceeds the approved case/audio budget");
}
/** Runs paced, real-provider recognition cases; every case closes its connection, including on timeout.
 * Deliberately reports transcription latency, not first audible response or inferred provider billing.
 */
export async function validateLiveRecognition(options: {
  gate: VoiceLiveValidationGate;
  provider: string;
  createRecognizer: (testCase: VoiceRecognitionCase) => SpeechRecognizer;
  cases: readonly VoiceRecognitionCase[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{
  accountLabel: string;
  provider: string;
  results: VoiceRecognitionResult[];
  finalAfterCommitMs: { p50?: number; p95?: number };
}> {
  if (!options.cases.length) throw new Error("Provide at least one recognition case");
  const durations = options.cases.map((testCase) => {
    if (!testCase.id || !testCase.languages.length || !testCase.frames.length)
      throw new Error("Incomplete recognition case");
    for (const frame of testCase.frames) validateAudioFrame(frame, testCase.frames[0]);
    return testCase.frames.reduce(
      (seconds, frame) => seconds + frame.bytes.length / (frame.encoding === "pcm_s16le" ? 2 : 1) / frame.sampleRateHz,
      0,
    );
  });
  requireVoiceLiveValidation(
    options.gate,
    options.provider,
    options.cases.length,
    durations.reduce((a, b) => a + b, 0),
  );
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error("Invalid validation timeout");
  const results: VoiceRecognitionResult[] = [];
  for (let i = 0; i < options.cases.length; i++) {
    options.signal?.throwIfAborted();
    const testCase = options.cases[i];
    const recognizer = options.createRecognizer(testCase);
    if (recognizer.capabilities.provider !== options.provider)
      throw new Error("Recognizer does not match approved provider");
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(
      () => controller.abort(new Error("Live recognition validation timed out")),
      options.timeoutMs ?? 60_000,
    );
    let session: Awaited<ReturnType<SpeechRecognizer["open"]>> | undefined;
    try {
      session = await recognizer.open(
        {
          format: testCase.frames[0],
          sessionId: `validation:${testCase.id}`,
          turnId: testCase.id,
          generationId: testCase.id,
          language: testCase.languages.length === 1 ? testCase.languages[0] : undefined,
        },
        signal,
      );
      const final = (async (): Promise<{ event: TranscriptEvent; received: number }> => {
        for await (const event of session!.events)
          if (event.kind === "final") return { event, received: performance.now() };
        throw new Error("Recognition stream ended without a final transcript");
      })();
      void final.catch(() => {});
      for (const frame of testCase.frames) {
        signal.throwIfAborted();
        await session.sendAudio(frame);
        const ms = (frame.bytes.length / (frame.encoding === "pcm_s16le" ? 2 : 1) / frame.sampleRateHz) * 1000;
        await sleep(ms, undefined, { signal });
      }
      const committed = performance.now();
      await session.flush();
      const { event, received } = await final;
      signal.throwIfAborted();
      if (received < committed) throw new Error("Recognizer committed before the host end-of-turn boundary");
      results.push({
        caseId: testCase.id,
        languages: [...testCase.languages],
        scenario: testCase.scenario,
        transcript: event.text,
        ...(event.languages !== undefined ? { detectedLanguages: event.languages } : {}),
        audioSeconds: durations[i],
        finalAfterCommitMs: received - committed,
        taskSuccess: testCase.requiredPhrases?.length
          ? testCase.requiredPhrases.every((phrase) =>
              event.text.normalize("NFKC").toLocaleLowerCase().includes(phrase.normalize("NFKC").toLocaleLowerCase()),
            )
          : null,
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      await session?.close();
    }
  }
  const values = results.map((result) => result.finalAfterCommitMs).sort((a, b) => a - b);
  return {
    accountLabel: options.gate.accountLabel,
    provider: options.provider,
    results,
    finalAfterCommitMs: {
      p50: values[Math.ceil(values.length * 0.5) - 1],
      p95: values[Math.ceil(values.length * 0.95) - 1],
    },
  };
}
export interface VoicePlaybackObservation {
  caseId: string;
  languages: readonly string[];
  scenario: "baseline" | "code-switching" | "interruption" | "reconnect";
  /** Measured by the same client clock: actual first audible sample minus end-of-turn. */
  firstAudibleMs?: number;
  taskSuccess?: boolean;
  staleFrames?: number;
  queueHighWaterBytes?: number;
  /** Provider-reported usage only. Never derive a monetary charge from generated audio. */
  billing?: readonly { provider: string; unit: string; quantity: number }[];
}
/** Aggregate host-instrumented playback; absent measurements stay absent, not zero or success. */
export function summarizeVoicePlayback(observations: readonly VoicePlaybackObservation[]) {
  for (const observation of observations) {
    for (const value of [observation.firstAudibleMs, observation.staleFrames, observation.queueHighWaterBytes])
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Invalid playback measurement");
    for (const usage of observation.billing ?? [])
      if (!Number.isFinite(usage.quantity) || usage.quantity < 0) throw new Error("Invalid billing measurement");
  }
  const audible = observations
    .flatMap((value) => (value.firstAudibleMs === undefined ? [] : [value.firstAudibleMs]))
    .sort((a, b) => a - b);
  const judged = observations.filter((value) => value.taskSuccess !== undefined);
  return {
    cases: observations.length,
    firstAudibleMs: {
      samples: audible.length,
      ...(audible.length
        ? { p50: audible[Math.ceil(audible.length * 0.5) - 1], p95: audible[Math.ceil(audible.length * 0.95) - 1] }
        : {}),
    },
    taskSuccess: {
      samples: judged.length,
      ...(judged.length ? { rate: judged.filter((value) => value.taskSuccess).length / judged.length } : {}),
    },
    observations: structuredClone(observations),
  };
}
