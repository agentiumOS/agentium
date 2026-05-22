import type { Agent } from "../agent/agent.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import type { ComparisonResult, ShadowConfig } from "./types.js";

export interface ShadowRunResult {
  primaryOutput: RunOutput;
  shadowOutput?: RunOutput;
  comparison?: ComparisonResult;
  shadowError?: Error;
  shadowLatencyMs?: number;
}

function defaultCompare(primary: RunOutput, shadow: RunOutput): ComparisonResult {
  const pText = primary.text.trim().toLowerCase();
  const sText = shadow.text.trim().toLowerCase();

  if (pText === sText) return { match: true, similarity: 1, differences: [] };

  const pWords = new Set(pText.split(/\s+/));
  const sWords = new Set(sText.split(/\s+/));
  const intersection = [...pWords].filter((w) => sWords.has(w)).length;
  const union = new Set([...pWords, ...sWords]).size;
  const similarity = union > 0 ? intersection / union : 0;

  const differences: string[] = [];
  if (primary.toolCalls.length !== shadow.toolCalls.length) {
    differences.push(`Tool call count: ${primary.toolCalls.length} vs ${shadow.toolCalls.length}`);
  }
  if (Math.abs(primary.text.length - shadow.text.length) > primary.text.length * 0.5) {
    differences.push(`Response length differs significantly: ${primary.text.length} vs ${shadow.text.length}`);
  }

  return { match: similarity > 0.9, similarity, differences };
}

export class ShadowRunner {
  private primary: Agent;
  private shadow: Agent;
  private compareFn: (primary: RunOutput, shadow: RunOutput) => ComparisonResult;

  constructor(primary: Agent, shadow: Agent, config?: ShadowConfig) {
    this.primary = primary;
    this.shadow = shadow;
    this.compareFn = config?.compareOutputs ?? defaultCompare;
  }

  async run(input: string, opts?: RunOpts): Promise<ShadowRunResult> {
    const shadowPromise = this.runShadow(input, opts);
    const primaryOutput = await this.primary.run(input, opts);

    const shadowResult = await shadowPromise;

    const result: ShadowRunResult = { primaryOutput };

    if (shadowResult.output) {
      result.shadowOutput = shadowResult.output;
      result.shadowLatencyMs = shadowResult.latencyMs;
      result.comparison = this.compareFn(primaryOutput, shadowResult.output);
    }
    if (shadowResult.error) {
      result.shadowError = shadowResult.error;
    }

    return result;
  }

  private async runShadow(
    input: string,
    opts?: RunOpts,
  ): Promise<{ output?: RunOutput; error?: Error; latencyMs: number }> {
    const start = Date.now();
    try {
      const output = await this.shadow.run(input, opts);
      return { output, latencyMs: Date.now() - start };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)), latencyMs: Date.now() - start };
    }
  }
}
