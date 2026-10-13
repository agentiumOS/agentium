import type { MessageContent, RunOpts, RunOutput } from "@agentium/core";

export interface EvalTarget {
  run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>;
}

export interface EvalCase {
  name: string;
  input: string | MessageContent;
  expected?: string;
  metadata?: Record<string, unknown>;
  runOpts?: RunOpts;
}

export interface ScorerResult {
  score: number;
  pass: boolean;
  reason?: string;
  status?: "graded" | "infrastructure_error";
}

export interface ScorerContext {
  signal: AbortSignal;
  deadline: number;
}

export interface Scorer {
  name: string;
  score(input: string, output: RunOutput, expected?: string, context?: ScorerContext): Promise<ScorerResult>;
}

export interface EvalResult {
  caseName?: string;
  input: string;
  output?: RunOutput;
  scores: Record<string, ScorerResult>;
  durationMs: number;
  pass: boolean;
  error?: string;
  failureKind?: "timeout" | "cancelled" | "infrastructure" | "execution";
  /** Callback ignored cancellation and is still settling; its session remains reserved. */
  cleanupPending?: boolean;
  gradingStatus?: "complete" | "incomplete";
}

export interface EvalSuiteResult {
  name: string;
  results: EvalResult[];
  passed: number;
  failed: number;
  total: number;
  averageScore: number;
  gradedCases?: number;
  infrastructureFailures?: number;
  /** Mean over valid grades in completely graded cases; null when none are available. */
  gradedAverageScore?: number | null;
  durationMs: number;
}

export interface EvalSuiteConfig {
  name: string;
  agent: EvalTarget;
  cases: EvalCase[];
  scorers: Scorer[];
  threshold?: number;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Reporter {
  report(result: EvalSuiteResult): void | Promise<void>;
}
