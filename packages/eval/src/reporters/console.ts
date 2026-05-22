import type { EvalSuiteResult, Reporter } from "../types.js";

export class ConsoleReporter implements Reporter {
  report(result: EvalSuiteResult): void {
    const line = "─".repeat(70);

    console.log(`\n${line}`);
    console.log(`  Eval Suite: ${result.name}`);
    console.log(`${line}`);

    for (const r of result.results) {
      const status = r.pass ? "PASS" : "FAIL";
      const icon = r.pass ? "+" : "-";
      console.log(`\n  [${icon}] ${status} | ${r.caseName} (${r.durationMs}ms)`);
      console.log(`      Input: ${r.input.slice(0, 80)}${r.input.length > 80 ? "..." : ""}`);

      for (const [scorerName, score] of Object.entries(r.scores)) {
        const mark = score.pass ? "+" : "-";
        console.log(
          `      [${mark}] ${scorerName}: ${score.score.toFixed(3)}${score.reason ? ` — ${score.reason}` : ""}`,
        );
      }
    }

    console.log(`\n${line}`);
    console.log(
      `  Results: ${result.passed}/${result.total} passed | Avg score: ${result.averageScore.toFixed(3)} | ${result.durationMs}ms`,
    );
    console.log(`${line}\n`);
  }
}
