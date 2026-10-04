export interface VoiceTiming {
  turnId: string;
  firstTextMs?: number;
  firstAudioMs?: number;
  durationMs: number;
}
/** Audio timing is first frame offered to transport; actual audible latency requires client measurements. */
export function summarizeVoiceTimings(
  timings: readonly VoiceTiming[],
): Record<"firstTextMs" | "firstAudioMs" | "durationMs", { samples: number; p50?: number; p95?: number }> {
  const summary = {} as ReturnType<typeof summarizeVoiceTimings>;
  for (const field of ["firstTextMs", "firstAudioMs", "durationMs"] as const) {
    const values = timings
      .map((timing) => timing[field])
      .filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    summary[field] = {
      samples: values.length,
      ...(values.length
        ? { p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1] }
        : {}),
    };
  }
  return summary;
}
