/**
 * LangChain JS Performance Benchmark
 *
 * Measures startup time, response latency, token usage (all types), memory,
 * and cost tracking across 5 scenarios.
 *
 * Extracts ALL available token types from OpenAI response metadata to see
 * what LangChain JS actually exposes.
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

const INPUT_PER_1K = 0.00015;
const OUTPUT_PER_1K = 0.0006;

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
}

interface ScenarioResult {
  name: string;
  startupMs: number;
  memoryMB: number;
  runs: RunResult[];
}

function memMB(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
}

function extractAllTokenDetails(result: any): TokenDetails {
  const usage = result.response_metadata?.usage ?? result.usage_metadata ?? {};
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;

  // Dig into OpenAI detailed token breakdowns that LangChain passes through
  const promptDetails = usage.prompt_tokens_details ?? {};
  const completionDetails = usage.completion_tokens_details ?? {};

  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    reasoning_tokens: completionDetails.reasoning_tokens ?? 0,
    cached_tokens: promptDetails.cached_tokens ?? 0,
    cache_write_tokens: 0, // OpenAI doesn't expose cache_write
    audio_input_tokens: promptDetails.audio_tokens ?? 0,
    audio_output_tokens: completionDetails.audio_tokens ?? 0,
  };
}

function extractTokensFromGraph(response: any): TokenDetails {
  let accumulated: TokenDetails = { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, audio_input_tokens: 0, audio_output_tokens: 0 };

  for (const msg of response.messages ?? []) {
    const usage = msg?.response_metadata?.usage ?? {};
    if (usage.prompt_tokens || usage.completion_tokens) {
      const promptDetails = usage.prompt_tokens_details ?? {};
      const completionDetails = usage.completion_tokens_details ?? {};
      accumulated.input_tokens += usage.prompt_tokens ?? 0;
      accumulated.output_tokens += usage.completion_tokens ?? 0;
      accumulated.reasoning_tokens += completionDetails.reasoning_tokens ?? 0;
      accumulated.cached_tokens += promptDetails.cached_tokens ?? 0;
      accumulated.audio_input_tokens += promptDetails.audio_tokens ?? 0;
      accumulated.audio_output_tokens += completionDetails.audio_tokens ?? 0;
    }
  }

  if (accumulated.input_tokens === 0 && accumulated.output_tokens === 0) {
    const lastMsg = response.messages?.[response.messages.length - 1];
    if (lastMsg) {
      return extractAllTokenDetails(lastMsg);
    }
  }

  accumulated.total_tokens = accumulated.input_tokens + accumulated.output_tokens;
  return accumulated;
}

// ---------- Scenario 1: Simple Completion ----------

async function scenario1(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { ChatOpenAI } = await import("@langchain/openai");
  const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

  const llm = new ChatOpenAI({ model: MODEL });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t1 = performance.now();
    const result = await llm.invoke([
      new SystemMessage("Answer concisely."),
      new HumanMessage(PROMPT_SIMPLE),
    ]);
    const responseMs = performance.now() - t1;
    const details = extractAllTokenDetails(result);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: details.input_tokens,
      completionTokens: details.output_tokens,
      totalTokens: details.total_tokens,
      tokenDetails: details,
    });
  }

  return {
    name: "simple_completion",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
  };
}

// ---------- Scenario 2: Tool Calling ----------

async function scenario2(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { ChatOpenAI } = await import("@langchain/openai");
  const { tool } = await import("@langchain/core/tools");
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { z } = await import("zod");

  const weatherTool = tool(
    async (input: { location: string }) => {
      return `Weather in ${input.location}: 60°F, foggy.`;
    },
    {
      name: "get_weather",
      description: "Get the current weather for a location",
      schema: z.object({ location: z.string().describe("City name") }),
    }
  );

  const llm = new ChatOpenAI({ model: MODEL });
  const agent = createReactAgent({
    llm,
    tools: [weatherTool],
    prompt: "Use tools to answer questions. Be concise.",
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t1 = performance.now();
    const result = await agent.invoke({
      messages: [{ role: "user", content: PROMPT_TOOL }],
    });
    const responseMs = performance.now() - t1;
    const details = extractTokensFromGraph(result);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: details.input_tokens,
      completionTokens: details.output_tokens,
      totalTokens: details.total_tokens,
      tokenDetails: details,
    });
  }

  return {
    name: "tool_calling",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
  };
}

// ---------- Scenario 3: Multi-turn Memory ----------

async function scenario3(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { ChatOpenAI } = await import("@langchain/openai");
  const { createReactAgent } = await import("@langchain/langgraph/prebuilt");
  const { MemorySaver } = await import("@langchain/langgraph");

  const llm = new ChatOpenAI({ model: MODEL });
  const memory = new MemorySaver();
  const agent = createReactAgent({
    llm,
    tools: [],
    prompt: "You are a helpful assistant. Remember what the user tells you.",
    checkpointSaver: memory,
  });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    const threadId = `bench-thread-${i}`;
    let accumulated: TokenDetails = { input_tokens: 0, output_tokens: 0, total_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, audio_input_tokens: 0, audio_output_tokens: 0 };
    const t1 = performance.now();

    for (const prompt of PROMPTS_MULTI) {
      const result = await agent.invoke(
        { messages: [{ role: "user", content: prompt }] },
        { configurable: { thread_id: threadId } }
      );
      const details = extractTokensFromGraph(result);
      accumulated.input_tokens += details.input_tokens;
      accumulated.output_tokens += details.output_tokens;
      accumulated.reasoning_tokens += details.reasoning_tokens;
      accumulated.cached_tokens += details.cached_tokens;
      accumulated.audio_input_tokens += details.audio_input_tokens;
      accumulated.audio_output_tokens += details.audio_output_tokens;
    }
    accumulated.total_tokens = accumulated.input_tokens + accumulated.output_tokens;

    const responseMs = performance.now() - t1;
    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: accumulated.input_tokens,
      completionTokens: accumulated.output_tokens,
      totalTokens: accumulated.total_tokens,
      tokenDetails: accumulated,
    });
  }

  return {
    name: "multi_turn_memory",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
  };
}

// ---------- Scenario 4: Prompt Caching ----------

async function scenario4(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { ChatOpenAI } = await import("@langchain/openai");
  const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

  const llm = new ChatOpenAI({ model: MODEL });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t1 = performance.now();
    const result = await llm.invoke([
      new SystemMessage("You are a precise astronomy assistant. Always answer in full detail."),
      new HumanMessage(PROMPT_CACHE),
    ]);
    const responseMs = performance.now() - t1;
    const details = extractAllTokenDetails(result);

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: details.input_tokens,
      completionTokens: details.output_tokens,
      totalTokens: details.total_tokens,
      tokenDetails: details,
    });
  }

  return {
    name: "prompt_caching",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
  };
}

// ---------- Scenario 5: Cost Tracking ----------

async function scenario5(): Promise<ScenarioResult> {
  const t0 = performance.now();
  const { ChatOpenAI } = await import("@langchain/openai");
  const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

  const llm = new ChatOpenAI({ model: MODEL });
  const startupMs = performance.now() - t0;
  const memBefore = memMB();

  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t1 = performance.now();
    const result = await llm.invoke([
      new SystemMessage("Answer precisely as instructed."),
      new HumanMessage(PROMPT_COST),
    ]);
    const responseMs = performance.now() - t1;
    const details = extractAllTokenDetails(result);

    // LangChain JS: manual cost — no built-in calculator in JS
    const costInput = (details.input_tokens / 1000) * INPUT_PER_1K;
    const costOutput = (details.output_tokens / 1000) * OUTPUT_PER_1K;

    runs.push({
      responseMs: Math.round(responseMs),
      promptTokens: details.input_tokens,
      completionTokens: details.output_tokens,
      totalTokens: details.total_tokens,
      tokenDetails: details,
      costTotal: costInput + costOutput,
      costInput,
      costOutput,
      costReasoning: 0,
      costCached: 0,
      costAudioInput: 0,
      costAudioOutput: 0,
    });
  }

  return {
    name: "cost_tracking",
    startupMs: Math.round(startupMs),
    memoryMB: Math.round((memMB() - memBefore) * 100) / 100,
    runs,
  };
}

// ---------- Main ----------

const results = {
  framework: "LangChain",
  model: MODEL,
  scenarios: [await scenario1(), await scenario2(), await scenario3(), await scenario4(), await scenario5()],
};

console.log(JSON.stringify(results, null, 2));
process.exit(0);
