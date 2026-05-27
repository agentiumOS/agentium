# @agentium/queue

Background job processing for Agentium agents using BullMQ and Redis.

## Install

```bash
npm install @agentium/queue bullmq ioredis
```

## Quick Start

```typescript
import { Agent, openai } from "@agentium/core";
import { AgentQueue, AgentWorker } from "@agentium/queue";

const agent = new Agent({ name: "assistant", model: openai("gpt-4o") });
const connection = { host: "localhost", port: 6379 };

const queue = new AgentQueue({ connection });
const worker = new AgentWorker({ agents: { assistant: agent }, connection });

await queue.enqueueAgentRun({ agentName: "assistant", input: "Hello!" });
```

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
