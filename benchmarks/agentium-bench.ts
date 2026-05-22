/**
 * Agentium Performance & Cost Accuracy Benchmark
 *
 * Measures startup time, response latency, token usage, memory, and
 * validates CostTracker accuracy against raw API token counts across
 * 5 scenarios: simple completion, tool calling, multi-turn memory,
 * prompt caching, and cost tracking.
 *
 * Each scenario attaches a CostTracker and compares:
 *   api_*   = tokens from result.usage (raw API response)
 *   tracker_* = tokens from CostTracker.getEntries() (our tracking)
 *
 * Outputs JSON to stdout for the report generator.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

// Load .env
try {
  const envPath = resolve(import.meta.dirname ?? ".", "../.env");
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^(\w+)\s*=\s*"?(.+?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env file */ }

const RUNS = 5;
const MODEL = "gpt-4o-mini";
const PROMPT_SIMPLE = "What is the capital of France? Answer in one sentence.";
const PROMPT_TOOL = "What is the weather in San Francisco?";
const PROMPTS_MULTI = [
  "My name is Alice and I live in Berlin.",
  "What city do I live in?",
  "What is my name?",
];
const PROMPT_COST = "Explain quantum computing in exactly 3 sentences.";
const PROMPT_CACHE = "List all planets in our solar system with one fact about each.";

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

interface TokenComparison {
  api: TokenDetails;
  tracker: TokenDetails;
  match: boolean;
}

interface RunResult {
  responseMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenDetails: TokenDetails;
  costTotal?: number;
  costInput?: number;
  costOutput?: number;
  costReasoning?: number;
  costCached?: number;
  costAudioInput?: number;
  costAudioOutput?: number;
  tokenAccuracy?: TokenComparison;
}

interface ScenarioResult {
  name: string;
  startupMs: number;
  memoryMB: number;
  runs: RunResult[];
  tokenAccuracyRate?: number;
}

function memMB(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
}

function usageToDetails(usage: any): TokenDetails {
  return {
    input_tokens: usage.promptTokens ?? 0,
    output_tokens: usage.completionTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    cached_tokens: usage.cachedTokens ?? 0,
    cache_write_tokens: 0, // OpenAI doesn't expose cache_write separately
    audio_input_tokens: usage.audioInputTokens ?? 0,
    audio_output_tokens: usage.audioOutputTokens ?? 0,
  };
}

function detailsMatch(a: TokenDetails, b: TokenDetails): boolean {
  return (
    a.input_tokens === b.input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.total_tokens === b.total_tokens &&
    a.reasoning_tokens === b.reasoning_tokens &&
    a.cached_tokens === b.cached_tokens &&
    a.audio_input_tokens === b.audio_input_tokens &&
    a.audio_output_tokens === b.audio_output_tokens
  );
}

function addDetails(a: TokenDetails, b: TokenDetails): TokenDetails {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    audio_input_tokens: a.audio_input_tokens + b.audio_input_tokens,
    audio_output_tokens: a.audio_output_tokens + b.audio_output_tokens,
  };
}

function emptyDetails(): TokenDetails {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, audio_input_tokens: 0, audio_output_tokens: 0 };
}

// ---------- Scenario 1: Simple Completion ----------

async function scenario1(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { Agent, openai, CostTracker } = await import("@agentium/core");

  const tracker = new CostTracker();
  const agent = new Agent({
    name: "bench-simple",
    model: openai(MODEL),
    instructions: "Answer concisely.",
    costTracker: tracker,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    tracker.reset();
    const t1 = performance.now();
    const result = await agent.run(PROMPT_SIMPLE);
    const responseMs = performance.now() - t1;

    const entry = tracker.getEntries().at(-1)!;
    const apiDetails = usageToDetails(result.usage);
    const trackerDetails = usageToDetails(entry.usage);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      tokenDetails: apiDetails,
      costTotal: entry.breakdown.total,
      costInput: entry.breakdown.input,
      costOutput: entry.breakdown.output,
      costReasoning: entry.breakdown.reasoning,
      costCached: entry.breakdown.cached,
      costAudioInput: entry.breakdown.audioInput,
      costAudioOutput: entry.breakdown.audioOutput,
      tokenAccuracy: { api: apiDetails, tracker: trackerDetails, match: detailsMatch(apiDetails, trackerDetails) },
    });
  }

  const matchCount = runs.filter((r) => r.tokenAccuracy?.match).length;
  return {
    name: "simple_completion",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
    tokenAccuracyRate: matchCount / runs.length,
  };
}

// ---------- Scenario 2: Tool Calling ----------

async function scenario2(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { Agent, openai, defineTool, CostTracker } = await import("@agentium/core");
  const { z } = await import("zod");

  const tracker = new CostTracker();
  const weatherTool = defineTool({
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: z.object({ location: z.string().describe("City name") }),
    execute: async ({ location }) => `Weather in ${location}: 60°F, foggy.`,
  });

  const agent = new Agent({
    name: "bench-tools",
    model: openai(MODEL),
    instructions: "Use tools to answer questions. Be concise.",
    tools: [weatherTool],
    costTracker: tracker,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    tracker.reset();
    const t1 = performance.now();
    const result = await agent.run(PROMPT_TOOL);
    const responseMs = performance.now() - t1;

    const summary = tracker.getSummary();
    const apiDetails = usageToDetails(result.usage);
    const trackerDetails = usageToDetails(summary.totalTokens);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      tokenDetails: apiDetails,
      costTotal: summary.totalBreakdown.total,
      costInput: summary.totalBreakdown.input,
      costOutput: summary.totalBreakdown.output,
      costReasoning: summary.totalBreakdown.reasoning,
      costCached: summary.totalBreakdown.cached,
      costAudioInput: summary.totalBreakdown.audioInput,
      costAudioOutput: summary.totalBreakdown.audioOutput,
      tokenAccuracy: { api: apiDetails, tracker: trackerDetails, match: detailsMatch(apiDetails, trackerDetails) },
    });
  }

  const matchCount = runs.filter((r) => r.tokenAccuracy?.match).length;
  return {
    name: "tool_calling",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
    tokenAccuracyRate: matchCount / runs.length,
  };
}

// ---------- Scenario 3: Multi-turn Memory ----------

async function scenario3(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { Agent, openai, CostTracker } = await import("@agentium/core");

  const tracker = new CostTracker();
  const agent = new Agent({
    name: "bench-memory",
    model: openai(MODEL),
    instructions: "You are a helpful assistant. Remember what the user tells you.",
    costTracker: tracker,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    tracker.reset();
    const sessionId = `bench-session-${i}`;
    let accumulated = emptyDetails();
    const t1 = performance.now();

    for (const prompt of PROMPTS_MULTI) {
      const result = await agent.run(prompt, { sessionId });
      accumulated = addDetails(accumulated, usageToDetails(result.usage));
    }

    const responseMs = performance.now() - t1;
    const summary = tracker.getSummary();
    const trackerDetails = usageToDetails(summary.totalTokens);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: accumulated.input_tokens,
      completionTokens: accumulated.output_tokens,
      totalTokens: accumulated.total_tokens,
      tokenDetails: accumulated,
      costTotal: summary.totalBreakdown.total,
      costInput: summary.totalBreakdown.input,
      costOutput: summary.totalBreakdown.output,
      costReasoning: summary.totalBreakdown.reasoning,
      costCached: summary.totalBreakdown.cached,
      costAudioInput: summary.totalBreakdown.audioInput,
      costAudioOutput: summary.totalBreakdown.audioOutput,
      tokenAccuracy: { api: accumulated, tracker: trackerDetails, match: detailsMatch(accumulated, trackerDetails) },
    });
  }

  const matchCount = runs.filter((r) => r.tokenAccuracy?.match).length;
  return {
    name: "multi_turn_memory",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
    tokenAccuracyRate: matchCount / runs.length,
  };
}

// ---------- Scenario 4: Prompt Caching ----------

async function scenario4(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { Agent, openai, CostTracker } = await import("@agentium/core");

  const tracker = new CostTracker();
  const agent = new Agent({
    name: "bench-cache",
    model: openai(MODEL),
    instructions: "You are a precise astronomy assistant. Always answer in full detail.",
    costTracker: tracker,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    tracker.reset();
    const t1 = performance.now();
    const result = await agent.run(PROMPT_CACHE);
    const responseMs = performance.now() - t1;

    const entry = tracker.getEntries().at(-1)!;
    const apiDetails = usageToDetails(result.usage);
    const trackerDetails = usageToDetails(entry.usage);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      tokenDetails: apiDetails,
      costTotal: entry.breakdown.total,
      costInput: entry.breakdown.input,
      costOutput: entry.breakdown.output,
      costReasoning: entry.breakdown.reasoning,
      costCached: entry.breakdown.cached,
      costAudioInput: entry.breakdown.audioInput,
      costAudioOutput: entry.breakdown.audioOutput,
      tokenAccuracy: { api: apiDetails, tracker: trackerDetails, match: detailsMatch(apiDetails, trackerDetails) },
    });
  }

  const matchCount = runs.filter((r) => r.tokenAccuracy?.match).length;
  return {
    name: "prompt_caching",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
    tokenAccuracyRate: matchCount / runs.length,
  };
}

// ---------- Scenario 5: Cost Tracking ----------

async function scenario5(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { Agent, openai, CostTracker } = await import("@agentium/core");

  const tracker = new CostTracker();
  const agent = new Agent({
    name: "bench-cost",
    model: openai(MODEL),
    instructions: "Answer precisely as instructed.",
    costTracker: tracker,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    tracker.reset();
    const t1 = performance.now();
    const result = await agent.run(PROMPT_COST, {
      sessionId: `cost-session-${i}`,
      userId: "bench-user",
    });
    const responseMs = performance.now() - t1;

    const entry = tracker.getEntries().at(-1)!;
    const apiDetails = usageToDetails(result.usage);
    const trackerDetails = usageToDetails(entry.usage);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      tokenDetails: apiDetails,
      costTotal: entry.breakdown.total,
      costInput: entry.breakdown.input,
      costOutput: entry.breakdown.output,
      costReasoning: entry.breakdown.reasoning,
      costCached: entry.breakdown.cached,
      costAudioInput: entry.breakdown.audioInput,
      costAudioOutput: entry.breakdown.audioOutput,
      tokenAccuracy: { api: apiDetails, tracker: trackerDetails, match: detailsMatch(apiDetails, trackerDetails) },
    });
  }

  const matchCount = runs.filter((r) => r.tokenAccuracy?.match).length;
  return {
    name: "cost_tracking",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
    tokenAccuracyRate: matchCount / runs.length,
  };
}

// ---------- Main ----------

const origLog = console.log;
console.log = (...args: any[]) => {
  const msg = String(args[0] ?? "");
  if (msg.startsWith("[Agent:") || msg.startsWith("[LLMLoop") || msg.startsWith("[ToolRouter")) return;
  origLog(...args);
};

const results = {
  framework: "Agentium",
  model: MODEL,
  scenarios: [
    await scenario1(),
    await scenario2(),
    await scenario3(),
    await scenario4(),
    await scenario5(),
  ],
};

console.log = origLog;
console.log(JSON.stringify(results, null, 2));
process.exit(0);
