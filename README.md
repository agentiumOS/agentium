# Agentium

[![npm version](https://img.shields.io/npm/v/@agentium/core.svg?label=%40agentium%2Fcore)](https://www.npmjs.com/package/@agentium/core)
[![npm downloads](https://img.shields.io/npm/dm/@agentium/core.svg)](https://www.npmjs.com/package/@agentium/core)
[![license](https://img.shields.io/npm/l/@agentium/core.svg)](https://github.com/agentiumOS/agentium/blob/main/LICENSE)

**Build, run, and manage multi-agent systems in Node.js / TypeScript.**

[Website](https://agentium.in) · [Documentation](https://docs.agentium.in) · [npm](https://www.npmjs.com/org/agentium) · [GitHub](https://github.com/agentiumOS/agentium)

Agentium is a TypeScript-native agent orchestration framework with zero dependency on meta-frameworks like LangGraph or Vercel AI SDK. It provides a clean, declarative API and a custom model abstraction layer that wraps raw provider SDKs directly.

> Install from npm: [`@agentium/core`](https://www.npmjs.com/package/@agentium/core) · full docs at [docs.agentium.in](https://docs.agentium.in)

## Features

- **Model-agnostic** — swap between OpenAI, Anthropic, Google Gemini, Ollama, or any OpenAI-compatible API with one line
- **Agents** — tool-calling loop, session history, memory, guardrails, hooks
- **Voice / Realtime Agents** — real-time voice conversations over WebSocket
- **Sessions & Memory** — session history, long-term summarization, cross-session user memory
- **Knowledge Base** — vector + BM25 hybrid search with reciprocal rank fusion
- **Teams** — multi-agent coordination with coordinate, route, broadcast, and collaborate modes
- **Workflows** — deterministic step execution with typed state, conditions, parallel steps, retry policies
- **Toolkit Catalog** — 18+ built-in toolkits with dynamic credential management via Admin API
- **Edge & IoT** — Raspberry Pi support with GPIO, I2C sensors, camera, BLE, Ollama local LLM
- **Transport** — Express REST + SSE streaming + Socket.IO real-time + Voice gateway
- **Queue** — BullMQ-based background job execution with progress tracking
- **Storage** — pluggable drivers: InMemory, SQLite, PostgreSQL, MongoDB, Redis, DynamoDB
- **Observability** — OpenTelemetry tracing, Prometheus metrics, Langfuse, structured logs

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@agentium/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@agentium/core.svg)](https://www.npmjs.com/package/@agentium/core) | Agents, Teams, Workflows, Models, Tools, Memory, Voice |
| [`@agentium/transport`](packages/transport) | [![npm](https://img.shields.io/npm/v/@agentium/transport.svg)](https://www.npmjs.com/package/@agentium/transport) | Express router + Socket.IO + Voice/Browser gateways |
| [`@agentium/queue`](packages/queue) | [![npm](https://img.shields.io/npm/v/@agentium/queue.svg)](https://www.npmjs.com/package/@agentium/queue) | BullMQ background jobs |
| [`@agentium/browser`](packages/browser) | [![npm](https://img.shields.io/npm/v/@agentium/browser.svg)](https://www.npmjs.com/package/@agentium/browser) | Vision-based browser automation |
| [`@agentium/eval`](packages/eval) | [![npm](https://img.shields.io/npm/v/@agentium/eval.svg)](https://www.npmjs.com/package/@agentium/eval) | Agent output testing and scoring |
| [`@agentium/observability`](packages/observability) | [![npm](https://img.shields.io/npm/v/@agentium/observability.svg)](https://www.npmjs.com/package/@agentium/observability) | Tracing, metrics, structured logging |
| [`@agentium/admin`](packages/admin) | [![npm](https://img.shields.io/npm/v/@agentium/admin.svg)](https://www.npmjs.com/package/@agentium/admin) | Admin CRUD API for runtime agent management |
| [`@agentium/edge`](packages/edge) | [![npm](https://img.shields.io/npm/v/@agentium/edge.svg)](https://www.npmjs.com/package/@agentium/edge) | IoT toolkits + edge runtime for Raspberry Pi |

## Quick Start

```bash
npm install @agentium/core openai
```

```typescript
import { Agent, openai } from "@agentium/core";

const agent = new Agent({
  name: "Assistant",
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
});

const result = await agent.run("What is the capital of France?");
console.log(result.text);
```

## Agent with Tools

```typescript
import { Agent, defineTool, openai } from "@agentium/core";
import { z } from "zod";

const weatherTool = defineTool({
  name: "getWeather",
  description: "Get weather for a city",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `It is sunny in ${city}`,
});

const agent = new Agent({
  name: "WeatherBot",
  model: openai("gpt-4o"),
  tools: [weatherTool],
  instructions: "You help with weather queries.",
});

const result = await agent.run("What's the weather in Tokyo?");
```

## Streaming

```typescript
for await (const chunk of agent.stream("Tell me a story")) {
  if (chunk.type === "text") process.stdout.write(chunk.text);
}
```

## Teams

```typescript
import { Agent, Team, TeamMode, openai } from "@agentium/core";

const team = new Team({
  name: "Research Team",
  mode: TeamMode.Coordinate,
  model: openai("gpt-4o"),
  members: [researchAgent, writerAgent, reviewerAgent],
});

const result = await team.run("Write a report on quantum computing.");
```

| Mode | Behavior |
|------|----------|
| `Coordinate` | Leader decomposes task, delegates to members, synthesizes outputs |
| `Route` | Leader picks one member, returns their response directly |
| `Broadcast` | All members get the same task in parallel, leader synthesizes |
| `Collaborate` | Members respond concurrently, leader checks consensus, iterates |

## Workflows

```typescript
import { Workflow } from "@agentium/core";

const workflow = new Workflow({
  name: "Pipeline",
  initialState: { topic: "AI", research: "", final: "" },
  steps: [
    { name: "research", agent: searchAgent, inputFrom: (s) => s.topic },
    { name: "write", agent: writerAgent },
    { name: "parallel-review", parallel: [
      { name: "grammar", agent: grammarAgent },
      { name: "fact-check", agent: factAgent },
    ]},
  ],
  retryPolicy: { maxRetries: 2, backoffMs: 1000 },
});

const result = await workflow.run();
```

## Express Server

```bash
npm install @agentium/transport express
```

```typescript
import express from "express";
import { Agent, openai } from "@agentium/core";
import { createAgentRouter } from "@agentium/transport";

new Agent({ name: "assistant", model: openai("gpt-4o") });

const app = express();
app.use(express.json());
app.use("/api", createAgentRouter());
app.listen(3000);
```

**Generated endpoints:**
- `POST /api/agents/:name/run` — JSON response
- `POST /api/agents/:name/stream` — SSE stream
- `POST /api/teams/:name/run`
- `POST /api/workflows/:name/run`
- `GET  /api/registry`

## Socket.IO Real-Time

```bash
npm install @agentium/transport socket.io
```

```typescript
import { Server as SocketIOServer } from "socket.io";
import { createAgentGateway } from "@agentium/transport";

const io = new SocketIOServer(httpServer);
createAgentGateway({ io });
```

**Events:** `agent.run` → `agent.chunk` → `agent.tool.call` → `agent.done`

## Background Jobs

```bash
npm install @agentium/queue bullmq ioredis
```

```typescript
import { AgentQueue, AgentWorker } from "@agentium/queue";

const queue = new AgentQueue({ connection: { host: "localhost", port: 6379 } });
await queue.enqueueAgentRun({ agentName: "report-gen", input: "Generate Q4 report" });

const worker = new AgentWorker({
  connection: { host: "localhost", port: 6379 },
  agentRegistry: { "report-gen": reportAgent },
});
worker.start();
```

## Storage Drivers

```typescript
import { InMemoryStorage, SqliteStorage, PostgresStorage } from "@agentium/core";

const storage = new InMemoryStorage();
const storage = new SqliteStorage("agentium.db");
const storage = new PostgresStorage("postgresql://...");
```

## Hooks and Guardrails

```typescript
const agent = new Agent({
  name: "safe-agent",
  model: openai("gpt-4o"),
  hooks: {
    beforeRun: async (ctx) => console.log("Starting run", ctx.runId),
    afterRun: async (ctx, output) => console.log("Done:", output.text.length, "chars"),
    onToolCall: async (ctx, toolName) => console.log("Calling tool:", toolName),
    onError: async (ctx, error) => console.error("Error:", error.message),
  },
  guardrails: {
    input: [{
      name: "no-pii",
      validate: async (input) =>
        input.includes("SSN") ? { pass: false, reason: "PII detected" } : { pass: true },
    }],
  },
});
```

## Browser Agents

```bash
npm install @agentium/browser playwright
```

```typescript
import { BrowserAgent } from "@agentium/browser";
import { openai } from "@agentium/core";

const agent = new BrowserAgent({
  model: openai("gpt-4o"),
  instructions: "You are a browser automation assistant.",
  headless: false,
});

const result = await agent.run("Go to github.com and find the agentium repo");
await agent.close();
```

## Model Providers

Provider SDKs are optional peer dependencies — install only what you use:

| Provider | Install | Factory |
|----------|---------|---------|
| OpenAI | `npm i openai` | `openai("gpt-4o")` |
| Anthropic | `npm i @anthropic-ai/sdk` | `anthropic("claude-sonnet-4-20250514")` |
| Google Gemini | `npm i @google/genai` | `google("gemini-2.0-flash")` |
| Ollama (local) | `npm i ollama` | `ollama("llama3")` |
| Groq / Together / DeepSeek | `npm i openai` | `openai("model-id", { baseURL, apiKey })` |

## Project Structure

```
packages/
  core/           @agentium/core           Agents, Teams, Workflows, Models, Tools, Memory, Voice
  transport/      @agentium/transport      Express + Socket.IO + Voice/Browser gateways
  queue/          @agentium/queue          BullMQ background jobs
  browser/        @agentium/browser        Vision-based browser automation
  eval/           @agentium/eval           Agent output evaluation framework
  observability/  @agentium/observability  Tracing, metrics, structured logging
  admin/          @agentium/admin          Admin CRUD API
  edge/           @agentium/edge           IoT toolkits and edge runtime
benchmarks/       Performance benchmarks
scripts/          Release and utility scripts
```

Examples and docs live in separate repositories under the [agentiumOS](https://github.com/agentiumOS) org.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, development workflow, and PR guidelines.

## License

MIT
