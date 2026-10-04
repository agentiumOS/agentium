import type { Agent, MessageContent, RunOpts, RunOutput } from "@agentium/core";

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
}

export interface EvalSuiteResult {
  name: string;
  results: EvalResult[];
  passed: number;
  failed: number;
  total: number;
  averageScore: number;
  durationMs: number;
}

export interface EvalSuiteConfig {
  name: string;
  agent: Agent;
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
