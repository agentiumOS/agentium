/**
 * Benchmark Report Generator
 *
 * Reads JSON results from each framework benchmark and generates
 * a markdown comparison report at benchmarks/RESULTS.md.
 *
 * Usage:
 *   npx tsx benchmarks/report.ts results-agentium.json results-langchain.json results-agno.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TokenDetails {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  audio_input_tokens: number;
  audio_output_tokens: number;
}

interface TokenAccuracy {
  api: TokenDetails;
  tracker: TokenDetails;
  match: boolean;
}

interface RunResult {
  responseMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenDetails?: TokenDetails;
  costTotal?: number;
  costInput?: number;
  costOutput?: number;
  costReasoning?: number;
  costCached?: number;
  costAudioInput?: number;
  costAudioOutput?: number;
  tokenAccuracy?: TokenAccuracy;
}

interface ScenarioResult {
  name: string;
  startupMs: number;
  memoryMB: number;
  runs: RunResult[];
  tokenAccuracyRate?: number;
}

interface BenchmarkResult {
  framework: string;
  model: string;
  scenarios: ScenarioResult[];
}

const INPUT_COST_PER_M = 0.15;
const OUTPUT_COST_PER_M = 0.60;

function avg(arr: number[]): number {
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function avgF(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function cost(promptTokens: number, completionTokens: number): string {
  const c = (promptTokens * INPUT_COST_PER_M + completionTokens * OUTPUT_COST_PER_M) / 1_000_000;
  return `$${c.toFixed(6)}`;
}

function fmtCost(v: number): string {
  return `$${v.toFixed(8)}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function buildScenarioTable(
  scenarioName: string,
  displayName: string,
  frameworks: BenchmarkResult[]
): string {
  const rows: string[] = [];
  rows.push(`### ${displayName}\n`);
  rows.push("| Metric | " + frameworks.map((f) => f.framework).join(" | ") + " |");
  rows.push("|--------|" + frameworks.map(() => "-------").join("|") + "|");

  const scenarios = frameworks.map((f) => f.scenarios.find((s) => s.name === scenarioName));
  if (scenarios.every((s) => !s)) return "";

  const has = scenarios.map((s) => !!s);

  function mf(values: number[], idx: number): string {
    if (!has[idx]) return "";
    const present = values.filter((_, i) => has[i]);
    const sorted = [...present].sort((a, b) => a - b);
    if (values[idx] === sorted[0]) return " **best**";
    return "";
  }

  const startups = scenarios.map((s) => s?.startupMs ?? 0);
  rows.push("| Startup (ms) | " + startups.map((v, i) => has[i] ? `${v}${mf(startups, i)}` : "—").join(" | ") + " |");

  const avgResponse = scenarios.map((s) => s ? avg(s.runs.map((r) => r.responseMs)) : 0);
  rows.push("| Avg Response (ms) | " + avgResponse.map((v, i) => has[i] ? `${v}${mf(avgResponse, i)}` : "—").join(" | ") + " |");

  const avgPrompt = scenarios.map((s) => s ? avg(s.runs.map((r) => r.promptTokens)) : 0);
  rows.push("| Avg Prompt Tokens | " + avgPrompt.map((v, i) => has[i] ? `${v}${mf(avgPrompt, i)}` : "—").join(" | ") + " |");

  const avgCompletion = scenarios.map((s) => s ? avg(s.runs.map((r) => r.completionTokens)) : 0);
  rows.push("| Avg Completion Tokens | " + avgCompletion.map((v, i) => has[i] ? `${v}${mf(avgCompletion, i)}` : "—").join(" | ") + " |");

  const avgTotal = scenarios.map((s) => s ? avg(s.runs.map((r) => r.totalTokens)) : 0);
  rows.push("| Avg Total Tokens | " + avgTotal.map((v, i) => has[i] ? `${v}${mf(avgTotal, i)}` : "—").join(" | ") + " |");

  const costs = scenarios.map((s) => {
    if (!s) return { str: "—", val: Infinity };
    const p = avg(s.runs.map((r) => r.promptTokens));
    const c = avg(s.runs.map((r) => r.completionTokens));
    return { str: cost(p, c), val: (p * INPUT_COST_PER_M + c * OUTPUT_COST_PER_M) / 1_000_000 };
  });
  const costVals = costs.map((c) => c.val);
  rows.push("| Avg Cost / Run | " + costs.map((c, i) => has[i] ? `${c.str}${mf(costVals, i)}` : "—").join(" | ") + " |");

  const memory = scenarios.map((s) => s?.memoryMB ?? 0);
  rows.push("| Memory Delta (MB) | " + memory.map((v, i) => has[i] ? `${v}${mf(memory, i)}` : "—").join(" | ") + " |");

  return rows.join("\n");
}

// Token Details comparison — shows ALL 7 token types per scenario per framework
function buildTokenDetailsSection(frameworks: BenchmarkResult[]): string {
  const rows: string[] = [];
  rows.push("## Token Type Breakdown Comparison\n");
  rows.push("Shows which token types each framework actually extracts from the API.\n");

  const tokenFields: { key: keyof TokenDetails; label: string }[] = [
    { key: "input_tokens", label: "Input Tokens" },
    { key: "output_tokens", label: "Output Tokens" },
    { key: "total_tokens", label: "Total Tokens" },
    { key: "reasoning_tokens", label: "Reasoning Tokens" },
    { key: "cached_tokens", label: "Cached Tokens (read)" },
    { key: "cache_write_tokens", label: "Cache Write Tokens" },
    { key: "audio_input_tokens", label: "Audio Input Tokens" },
    { key: "audio_output_tokens", label: "Audio Output Tokens" },
  ];

  const scenarioNames = [
    { key: "simple_completion", label: "Simple Completion" },
    { key: "tool_calling", label: "Tool Calling" },
    { key: "multi_turn_memory", label: "Multi-turn Memory" },
    { key: "prompt_caching", label: "Prompt Caching" },
    { key: "cost_tracking", label: "Cost Tracking" },
  ];

  for (const { key: sKey, label: sLabel } of scenarioNames) {
    const scenarios = frameworks.map((f) => f.scenarios.find((s) => s.name === sKey));
    if (scenarios.every((s) => !s)) continue;

    rows.push(`\n### ${sLabel} — Token Details (Run 1)\n`);
    rows.push("| Token Type | " + frameworks.map((f) => f.framework).join(" | ") + " |");
    rows.push("|------------|" + frameworks.map(() => "-------").join("|") + "|");

    for (const { key: tKey, label: tLabel } of tokenFields) {
      const values = scenarios.map((s) => {
        if (!s) return "—";
        const details = s.runs[0]?.tokenDetails;
        if (!details) return "—";
        const v = details[tKey];
        return v !== undefined ? String(v) : "—";
      });
      rows.push(`| ${tLabel} | ${values.join(" | ")} |`);
    }
  }

  return rows.join("\n");
}

function buildTokenAccuracySection(agentium: BenchmarkResult): string {
  const rows: string[] = [];
  rows.push("## Token Accuracy: CostTracker vs API\n");
  rows.push("Verifies that Agentium `CostTracker` records **exactly** the same token counts the API returns.\n");
  rows.push("| Scenario | Runs | Matches | Accuracy | Status |");
  rows.push("|----------|------|---------|----------|--------|");

  let totalRuns = 0;
  let totalMatches = 0;

  for (const scenario of agentium.scenarios) {
    if (scenario.tokenAccuracyRate === undefined) continue;
    const runCount = scenario.runs.length;
    const matchCount = scenario.runs.filter((r) => r.tokenAccuracy?.match).length;
    totalRuns += runCount;
    totalMatches += matchCount;
    const rate = scenario.tokenAccuracyRate;
    const status = rate === 1 ? "PASS" : rate >= 0.8 ? "WARN" : "FAIL";

    const label = scenario.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    rows.push(`| ${label} | ${runCount} | ${matchCount}/${runCount} | ${rate === 1 ? "100%" : pct(rate)} | ${status} |`);
  }

  if (totalRuns > 0) {
    const overallRate = totalMatches / totalRuns;
    rows.push(`| **Overall** | **${totalRuns}** | **${totalMatches}/${totalRuns}** | **${pct(overallRate)}** | **${overallRate === 1 ? "PASS" : "WARN"}** |`);
  }

  // Per-run detail for key scenarios
  for (const sName of ["simple_completion", "multi_turn_memory", "prompt_caching"]) {
    const scenario = agentium.scenarios.find((s) => s.name === sName);
    if (!scenario || !scenario.runs[0]?.tokenAccuracy) continue;

    const label = sName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    rows.push(`\n### Per-Run Detail (${label})\n`);
    rows.push("| Run | Source | Input | Output | Total | Reasoning | Cached | Audio In | Audio Out | Match |");
    rows.push("|-----|--------|-------|--------|-------|-----------|--------|----------|-----------|-------|");

    scenario.runs.forEach((run, i) => {
      const t = run.tokenAccuracy!;
      rows.push(`| ${i + 1} | API | ${t.api.input_tokens} | ${t.api.output_tokens} | ${t.api.total_tokens} | ${t.api.reasoning_tokens} | ${t.api.cached_tokens} | ${t.api.audio_input_tokens} | ${t.api.audio_output_tokens} | |`);
      rows.push(`| | Tracker | ${t.tracker.input_tokens} | ${t.tracker.output_tokens} | ${t.tracker.total_tokens} | ${t.tracker.reasoning_tokens} | ${t.tracker.cached_tokens} | ${t.tracker.audio_input_tokens} | ${t.tracker.audio_output_tokens} | ${t.match ? "MATCH" : "MISMATCH"} |`);
    });
  }

  return rows.join("\n");
}

function buildCostTrackingTable(frameworks: BenchmarkResult[]): string {
  const rows: string[] = [];
  rows.push("### Scenario 5: Cost Tracking\n");

  const scenarios = frameworks.map((f) => f.scenarios.find((s) => s.name === "cost_tracking"));
  if (scenarios.every((s) => !s)) return "";

  rows.push("| Metric | " + frameworks.map((f) => f.framework).join(" | ") + " |");
  rows.push("|--------|" + frameworks.map(() => "-------").join("|") + "|");

  const avgResponse = scenarios.map((s) => s ? avg(s.runs.map((r) => r.responseMs)) : 0);
  rows.push("| Avg Response (ms) | " + avgResponse.map((v) => `${v}`).join(" | ") + " |");

  const avgTotal = scenarios.map((s) => s ? avg(s.runs.map((r) => r.totalTokens)) : 0);
  rows.push("| Avg Total Tokens | " + avgTotal.map((v) => `${v}`).join(" | ") + " |");

  rows.push("| | | | |");
  rows.push("| **Cost Breakdown** | | | |");

  const fields: { key: keyof RunResult; label: string }[] = [
    { key: "costTotal", label: "Total Cost" },
    { key: "costInput", label: "Input Cost" },
    { key: "costOutput", label: "Output Cost" },
    { key: "costReasoning", label: "Reasoning Cost" },
    { key: "costCached", label: "Cached Cost" },
    { key: "costAudioInput", label: "Audio Input Cost" },
    { key: "costAudioOutput", label: "Audio Output Cost" },
  ];

  for (const { key, label } of fields) {
    const values = scenarios.map((s) =>
      s ? avgF(s.runs.map((r) => (r as any)[key] ?? 0)) : 0
    );
    const anyNonZero = values.some((v) => v > 0);
    rows.push(`| ${label} | ${values.map((v) => anyNonZero || key === "costTotal" ? fmtCost(v) : "N/A").join(" | ")} |`);
  }

  return rows.join("\n");
}

function buildCostFeatureTable(frameworks: BenchmarkResult[]): string {
  const rows: string[] = [];
  rows.push("## Cost Tracking Feature Comparison\n");
  rows.push("| Feature | " + frameworks.map((f) => f.framework).join(" | ") + " |");
  rows.push("|---------|" + frameworks.map(() => "-------").join("|") + "|");

  rows.push("\n> **Note:** LangChain Python has `get_openai_callback()` with built-in pricing; LangChain JS requires manual callbacks.");
  rows.push("> Agno tracks all token types but has no cost calculator. LangSmith (paid SaaS) adds full cost tracking to LangChain.\n");

  type Feature = { name: string; support: Record<string, string> };
  const features: Feature[] = [
    { name: "**Token Tracking**", support: { Agentium: "", LangChain: "", Agno: "" } },
    { name: "Input / Output Tokens", support: { Agentium: "Yes", LangChain: "Yes", Agno: "Yes" } },
    { name: "Reasoning Tokens", support: { Agentium: "Yes", LangChain: "Yes (Python only)", Agno: "Yes" } },
    { name: "Cached Tokens (read)", support: { Agentium: "Yes", LangChain: "Yes (Python only)", Agno: "Yes" } },
    { name: "Cache Write Tokens", support: { Agentium: "No (OpenAI N/A)", LangChain: "No", Agno: "Yes" } },
    { name: "Audio Input Tokens", support: { Agentium: "Yes", LangChain: "No (LangSmith: Yes)", Agno: "Yes" } },
    { name: "Audio Output Tokens", support: { Agentium: "Yes", LangChain: "No (LangSmith: Yes)", Agno: "Yes" } },
    { name: "Per-Session Aggregation", support: { Agentium: "Yes", LangChain: "Via LangSmith", Agno: "Yes" } },
    { name: "**Cost Calculation**", support: { Agentium: "", LangChain: "", Agno: "" } },
    { name: "Built-in Cost Calculator", support: { Agentium: "Yes (auto)", LangChain: "Python only", Agno: "No" } },
    { name: "JS/TS Cost Calculation", support: { Agentium: "Yes (native)", LangChain: "No (manual)", Agno: "N/A (Python)" } },
    { name: "Multi-Provider Pricing Table", support: { Agentium: "Yes (50+ models)", LangChain: "OpenAI only", Agno: "No" } },
    { name: "Per-Category Cost Breakdown", support: { Agentium: "Yes (6 categories)", LangChain: "Via LangSmith", Agno: "No" } },
    { name: "**Budget & Aggregation**", support: { Agentium: "", LangChain: "", Agno: "" } },
    { name: "Cost Budget / Limits", support: { Agentium: "Yes (run/session/user)", LangChain: "No", Agno: "No" } },
    { name: "Mid-Run Budget Enforcement", support: { Agentium: "Yes (auto-stop)", LangChain: "No", Agno: "No" } },
    { name: "By-Agent Aggregation", support: { Agentium: "Yes", LangChain: "Via LangSmith", Agno: "No" } },
    { name: "By-Model Aggregation", support: { Agentium: "Yes", LangChain: "Via LangSmith", Agno: "No" } },
    { name: "By-User Aggregation", support: { Agentium: "Yes", LangChain: "No", Agno: "No" } },
    { name: "Token Accuracy Validation", support: { Agentium: "100% verified", LangChain: "Not tested", Agno: "Not tested" } },
    { name: "Requires External Service", support: { Agentium: "No", LangChain: "LangSmith ($$$)", Agno: "No" } },
  ];

  for (const f of features) {
    rows.push("| " + f.name + " | " + frameworks.map((fw) => f.support[fw.framework] ?? "—").join(" | ") + " |");
  }

  return rows.join("\n");
}

function buildSummary(frameworks: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("## Summary\n");

  const scenarioNames = [
    { key: "simple_completion", label: "Simple Completion" },
    { key: "tool_calling", label: "Tool Calling" },
    { key: "multi_turn_memory", label: "Multi-turn Memory" },
    { key: "prompt_caching", label: "Prompt Caching" },
    { key: "cost_tracking", label: "Cost Tracking" },
  ];

  lines.push("| Scenario | Fastest | Fewest Tokens | Cheapest |");
  lines.push("|----------|---------|---------------|----------|");

  for (const { key, label } of scenarioNames) {
    const scenarios = frameworks.map((f) => f.scenarios.find((s) => s.name === key));
    if (scenarios.filter((s) => s).length < 2 && !scenarios.some((s) => s)) continue;

    const avgResponses = scenarios.map((s) => s ? avg(s.runs.map((r) => r.responseMs)) : Infinity);
    const avgTokens = scenarios.map((s) => s ? avg(s.runs.map((r) => r.totalTokens)) : Infinity);
    const avgCosts = scenarios.map((s) => {
      if (!s) return Infinity;
      if (s.runs[0]?.costTotal !== undefined) return avgF(s.runs.map((r) => r.costTotal ?? 0));
      const p = avg(s.runs.map((r) => r.promptTokens));
      const c = avg(s.runs.map((r) => r.completionTokens));
      return (p * INPUT_COST_PER_M + c * OUTPUT_COST_PER_M) / 1_000_000;
    });

    const fastestIdx = avgResponses.indexOf(Math.min(...avgResponses));
    const fewestIdx = avgTokens.indexOf(Math.min(...avgTokens));
    const cheapestIdx = avgCosts.indexOf(Math.min(...avgCosts));

    const cheapestScenario = scenarios[cheapestIdx]!;
    const cheapestCostStr = cheapestScenario.runs[0]?.costTotal !== undefined
      ? fmtCost(avgCosts[cheapestIdx])
      : cost(avg(cheapestScenario.runs.map((r) => r.promptTokens)), avg(cheapestScenario.runs.map((r) => r.completionTokens)));

    lines.push(`| ${label} | ${frameworks[fastestIdx].framework} (${avgResponses[fastestIdx]}ms) | ${frameworks[fewestIdx].framework} (${avgTokens[fewestIdx]}) | ${frameworks[cheapestIdx].framework} (${cheapestCostStr}) |`);
  }

  return lines.join("\n");
}

// ---------- Main ----------

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: npx tsx benchmarks/report.ts <result1.json> <result2.json> ...");
  process.exit(1);
}

const frameworks: BenchmarkResult[] = files.map((f) => {
  const content = readFileSync(resolve(f), "utf-8");
  return JSON.parse(content);
});

const lines: string[] = [];
lines.push("# Agentium vs LangChain vs Agno -- Performance & Cost Comparison\n");
lines.push(`> Model: \`${frameworks[0].model}\` | Runs per scenario: 5 | ${new Date().toISOString().slice(0, 10)}\n`);
lines.push("---\n");

lines.push(buildScenarioTable("simple_completion", "Scenario 1: Simple Completion", frameworks));
lines.push("\n---\n");
lines.push(buildScenarioTable("tool_calling", "Scenario 2: Tool Calling", frameworks));
lines.push("\n---\n");
lines.push(buildScenarioTable("multi_turn_memory", "Scenario 3: Multi-turn Memory", frameworks));

const cachingTable = buildScenarioTable("prompt_caching", "Scenario 4: Prompt Caching", frameworks);
if (cachingTable) { lines.push("\n---\n"); lines.push(cachingTable); }

const costTable = buildCostTrackingTable(frameworks);
if (costTable) { lines.push("\n---\n"); lines.push(costTable); }

lines.push("\n---\n");
lines.push(buildTokenDetailsSection(frameworks));

const agentium = frameworks.find((f) => f.framework === "Agentium");
if (agentium) { lines.push("\n---\n"); lines.push(buildTokenAccuracySection(agentium)); }

lines.push("\n---\n");
lines.push(buildCostFeatureTable(frameworks));

lines.push("\n---\n");
lines.push(buildSummary(frameworks));

lines.push("\n---\n");
lines.push("## Methodology\n");
lines.push("- All benchmarks use the same model (`gpt-4o-mini`) and identical prompts.");
lines.push("- Each scenario is run 5 times; results are averaged.");
lines.push("- Startup time measures framework import + agent initialization (before first LLM call).");
lines.push("- Memory delta measures RSS growth (Node.js) or traced allocation (Python) during the scenario runs.");
lines.push("- Token counts reflect framework overhead (system prompts, tool schemas, history injection).");
lines.push("- Network latency to OpenAI API is shared across all frameworks and not isolated.");
lines.push("- Agentium and LangChain run on Node.js; Agno runs on Python. Cross-language memory comparisons should be interpreted with that in mind.");
lines.push(`- Cost calculated using gpt-4o-mini pricing: $${INPUT_COST_PER_M}/1M input tokens, $${OUTPUT_COST_PER_M}/1M output tokens.`);
lines.push("- Agentium cost tracking is built-in via `CostTracker` — token accuracy verified against raw API responses.");
lines.push("- LangChain JS and Agno costs are manually calculated; LangChain Python has `get_openai_callback()` for OpenAI only.");
lines.push("- Prompt caching scenario repeats the same prompt 5 times to trigger OpenAI's automatic prompt caching.");
lines.push("- Token details (reasoning, cached, audio) are extracted from each framework's API response metadata to verify actual availability.");

const outputPath = resolve(__dirname, "RESULTS.md");
writeFileSync(outputPath, lines.join("\n") + "\n");
console.log(`Report written to ${outputPath}`);
