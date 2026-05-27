# @agentium/admin

Admin CRUD API for dynamically creating, updating, and deleting Agentium agents, teams, and workflows at runtime — backed by the same global `Registry` used by `@agentium/transport`.

## Install

```bash
npm install @agentium/admin express
```

## Quick Start

```typescript
import express from "express";
import { InMemoryStorage } from "@agentium/core";
import { createAdminRouter } from "@agentium/admin";

const app = express();
app.use(express.json());

const { router, hydrate } = createAdminRouter({
  storage: new InMemoryStorage(),
  // Optional: pre-baked toolkits & raw tools that admin-created agents can reference by name
  toolkits: [],
  toolLibrary: {},
});

// Restore previously persisted agents / teams / workflows / toolkit configs.
await hydrate();

app.use("/admin", router);
app.listen(4000);
```

## Endpoints

The router exposes REST CRUD over the live registry. Entities are persisted to the supplied `storage` driver and rehydrated by `hydrate()` on startup.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents` | Create an agent from a blueprint |
| `GET`  | `/agents` | List all admin-created agents |
| `GET`  | `/agents/:name` | Inspect one agent |
| `PUT`  | `/agents/:name` | Replace an agent |
| `DELETE` | `/agents/:name` | Remove from registry + storage |
| `POST` | `/teams` · `GET /teams` · `GET/PUT/DELETE /teams/:name` | Team CRUD |
| `POST` | `/workflows` · `GET /workflows` · `GET/PUT/DELETE /workflows/:name` | Workflow CRUD |
| `POST` | `/toolkits` | Register a toolkit config (e.g. GitHub, Slack) with credentials |
| `GET`  | `/toolkits` | List configured toolkits (credentials masked) |
| `DELETE` | `/toolkits/:name` | Deactivate a toolkit |
| `GET`  | `/tools` | List every tool currently available (from toolkits + static library + dynamic configs) |

## Socket.IO Gateway

For real-time admin UIs:

```typescript
import { Server } from "socket.io";
import { createAdminGateway } from "@agentium/admin";

const io = new Server(httpServer);
createAdminGateway({ io, storage });
```

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT
