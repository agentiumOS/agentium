# @agentium/core

Core framework for building AI agents with tools, memory, multi-model support, and more.

## Install

```bash
npm install @agentium/core
```

## Quick Start

```typescript
import { Agent, openai } from "@agentium/core";

const agent = new Agent({
  name: "assistant",
  model: openai("gpt-4o"),
  instructions: "You are a helpful assistant.",
});

const result = await agent.run("Hello!");
console.log(result.text);
```

## Features

- **Multi-model** — OpenAI, Anthropic, Google, Ollama, Vertex AI
- **Tools** — Define tools with Zod schemas, sandboxed execution, approval workflows, strict mode
- **18 Built-in Toolkits** — Calculator, GitHub, Slack, Jira, Notion, SQL, and more with a `toolkitCatalog` for UI-driven config
- **Auto-Discovery** — Agents, teams, and workflows auto-register into a global `Registry`; transport layers discover them dynamically
- **Memory** — Unified memory system with summaries, user facts, entity memory
- **Teams & Workflows** — Multi-agent coordination with handoffs
- **Streaming** — First-class streaming support
- **Guardrails** — Input/output validation
- **Cost Tracking** — Token budgets and cost monitoring
- **Semantic Cache** — Vector-based response caching

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
