import { writeFile } from "node:fs/promises";
import type { EvalSuiteResult, Reporter } from "../types.js";

export class JsonReporter implements Reporter {
  private outputPath: string;

  constructor(outputPath?: string) {
    this.outputPath = outputPath ?? `eval-results-${Date.now()}.json`;
  }

  async report(result: EvalSuiteResult): Promise<void> {
    const serializable = {
      ...result,
      results: result.results.map((r) => ({
        caseName: r.caseName,
        input: r.input,
        outputText: r.output?.text,
        scores: r.scores,
        durationMs: r.durationMs,
        pass: r.pass,
        usage: r.output?.usage,
      })),
    };

    try {
      await writeFile(this.outputPath, JSON.stringify(serializable, null, 2));
      console.log(`Eval results written to ${this.outputPath}`);
    } catch (err) {
      console.warn(`Failed to write eval report to ${this.outputPath}:`, err instanceof Error ? err.message : err);
    }
  }
}
