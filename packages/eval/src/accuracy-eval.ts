import type { ModelProvider } from "@agentium/core";
import { AgentJudgeEval } from "./agent-judge-eval.js";
import type { EvalCase, EvalTarget, Reporter } from "./types.js";
export interface AccuracyEvalConfig {
  name: string;
  agent: EvalTarget;
  cases: EvalCase[];
  judge: ModelProvider;
  threshold?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AccuracyEval {
  private evaluator: AgentJudgeEval;
  constructor(config: AccuracyEvalConfig) {
    this.evaluator = new AgentJudgeEval({ ...config, criteria: ["accuracy"], scoringMode: "numeric" });
  }
  run(reporters?: Reporter[]) {
    return this.evaluator.run(reporters);
  }
}
