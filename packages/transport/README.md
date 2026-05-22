# @agentium/transport

HTTP and WebSocket transport layer for deploying Agentium agents as APIs.

## Install

```bash
npm install @agentium/transport
```

## Quick Start

```typescript
import express from "express";
import { Agent, openai } from "@agentium/core";
import { createAgentRouter } from "@agentium/transport";

const app = express();
app.use(express.json());

const agent = new Agent({
  name: "assistant",
  model: openai("gpt-4o"),
});

app.use("/api", createAgentRouter({ agents: { assistant: agent } }));
app.listen(3000);
```

## Features

- **Auto-Discovery** — Reads from the global `Registry` at request time; agents created after server start are immediately available
- **Express Router** — REST API with streaming support and list endpoints (`GET /agents`, `/teams`, `/workflows`, `/tools`)
- **Socket.IO Gateway** — Real-time WebSocket communication with dynamic agent/team lookup and tool discovery
- **A2A Server** — Agent-to-Agent protocol support
- **CORS & Rate Limiting** — Built-in security middleware
- **Swagger** — Auto-generated API documentation
- **File Upload** — Multipart form data support

## Documentation

Full docs at [agentium.mintlify.dev](https://agentium.mintlify.dev)

## License

MIT
