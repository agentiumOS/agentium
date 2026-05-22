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

export interface Scorer {
  name: string;
  score(input: string, output: RunOutput, expected?: string): Promise<ScorerResult>;
}

export interface EvalResult {
  caseName?: string;
  input: string;
  output?: RunOutput;
  scores: Record<string, ScorerResult>;
  durationMs: number;
  pass: boolean;
  error?: string;
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
}

export interface Reporter {
  report(result: EvalSuiteResult): void | Promise<void>;
}
