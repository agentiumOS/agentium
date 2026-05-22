export type ProgressEvent =
  | { type: "run.started"; runId: string; agentName: string }
  | { type: "step.started"; step: string; description?: string }
  | { type: "step.finished"; step: string; durationMs: number }
  | { type: "thinking"; content: string }
  | { type: "tool.executing"; toolName: string; args?: unknown }
  | { type: "tool.completed"; toolName: string; durationMs: number; preview?: string }
  | { type: "text.delta"; text: string }
  | { type: "progress"; percent: number; message?: string }
  | { type: "intermediate.result"; content: string }
  | { type: "run.finished"; runId: string; durationMs: number; tokenCount?: number }
  | { type: "run.error"; runId: string; error: string }
  | { type: "run.cancelled"; runId: string };

export function estimateProgress(roundtrip: number, maxRoundtrips: number, phase: "llm" | "tools"): number {
  const baseProgress = (roundtrip / maxRoundtrips) * 100;
  const phaseOffset = phase === "llm" ? 0 : 50 / maxRoundtrips;
  return Math.min(99, Math.round(baseProgress + phaseOffset));
}

export function toolResultPreview(result: string, maxLength = 100): string {
  const cleaned = result.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 3)}...`;
}
