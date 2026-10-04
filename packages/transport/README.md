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

app.use("/api", createAgentRouter({ security: { mode: "local" }, agents: { assistant: agent } }));
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

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT

## Authenticated HTTP hosting

`createAgentRouter` now requires an explicit identity resolver and resource authorizer whenever
JWT or RBAC is configured. Scope checks alone do not establish session, checkpoint, or approval
ownership. Authenticated configuration missing either hook throws during router creation.

```ts
app.use("/api", createAgentRouter({
  agents: { assistant: agent },
  registry: false,
  jwt: { secret: process.env.JWT_SECRET! },
  rbac: {},
  security: {
    mode: "authenticated",
    resolveIdentity: (claims) => {
      const verified = claims as { sub?: string; tenant?: string };
      return verified.sub
        ? { userId: verified.sub, tenantId: verified.tenant }
        : null;
    },
    authorizeResource: async ({ identity, operation, resource }) => {
      // Application-owned implementation; use authoritative records and default-deny.
      // session:create must atomically bind this new ID before resolving true.
      return ownership.authorizeAndBind({ identity, operation, resource });
    },
  },
}));
```

The `ownership` service above is an application dependency, not a provided in-memory store.
It must return `false` for unknown or unmigrated ownerless records. Do not infer ownership
from a request body, checkpoint contents, or possession of an ID. Store session IDs globally
uniquely and check both the intended actor and tenant according to your application's policy.
For new executions, the router generates a UUID and waits for `session:create` to persist
its owner binding; failure prevents Agent/Team/Workflow execution. A supplied session ID
requires `session:use` and cannot implicitly claim an existing or unknown session. The selected
ID is returned in `X-Agentium-Session-Id`, including for streaming requests.

Host authentication middleware in `middleware` runs before JWT/RBAC and may populate `req.user`
from credentials it verifies itself. `resolveIdentity` receives only that verified value.
Authenticated body `userId`/`tenantId` values must match the resolved identity if supplied;
execution and correction handlers use the resolved values. Multipart run requests perform
identity and ownership checks after parsing their fields and before Agent execution.
Do not configure middleware that copies unverified request claims into `req.user`.

The resource authorizer receives these operations:

| Operation | Resource and required host decision |
| --- | --- |
| `session:create`, `session:use` | Session ID and agent/team/workflow name; atomically bind a new ID or verify existing ownership. |
| `run:use`, `checkpoints:list` | Run ID and agent name; verify ownership before correction association or checkpoint listing. |
| `checkpoint:restore` | Checkpoint ID and agent name; verify authoritative ownership before rollback. |
| `approval:read`, `approval:approve`, `approval:deny` | Request ID; verify ownership. Pending lists and SSE events are filtered individually. |
| `correction:create` | Agent name and requested `scope`; authorize correction visibility. Referenced run/session IDs are checked separately. |
| `schedules:list` | Entire schedule collection; allow only callers entitled to see all returned schedules. |
| `schedule:create`, `schedule:delete` | Schedule ID; authorize creation or deletion. Creation grants management authority for that ID, including replacement and all configured scheduler targets. |
| `admin:get`, `admin:post`, `admin:put`, `admin:patch`, `admin:delete` | Full admin path; authorize administration at that path. |

Do not grant collection/admin/scheduler management operations to users needing only per-item
or restricted-target access; use a dedicated host endpoint until those APIs offer narrower
contracts. Successful scope checks, including `admin:*`, never bypass resource authorization.
This hook does not migrate the underlying storage to a multi-tenant schema.

RBAC now explicitly covers approvals, corrections, checkpoints/rollback, schedules, metrics,
tool listings, discovery and nested admin routes. Unknown routes return 403, including for
administrators, until registered in `rbac.defaultScopes`. An explicit empty scope array means
"any authenticated identity". `rbac.agentScopes` applies before Express route parameters are
populated. Optional `rbac.publicRoutes`, such as `["GET /agents"]`, permits intentionally public
listings or documentation. Resource control routes still require verified identity/ownership.
Swagger paths need an explicit public route or a `defaultScopes` entry when RBAC is enabled.

Every router now requires an explicit `security` option. For a trusted local application, use
`security: { mode: "local" }`. For hosted use, select `mode: "authenticated"` and provide both
identity and resource authorization hooks. Omitting security or choosing an unknown mode fails
before discovery, middleware setup, or optional dependency loading. Local mode cannot be combined
with JWT/RBAC; configuration never silently downgrades authentication. The text Socket.IO gateway has the explicit contract below. Standalone admin routers and A2A servers retain their own deployment authorization.

Team and Workflow HTTP routes enforce session ownership before calling their runtime. Their internal Agent delegation now carries tenant/user/run lineage, cancellation and execution policy. Custom workflow callbacks remain trusted host code; route authorization does not sandbox them.

### Text gateway security and connection ownership

`createAgentGateway` also requires `security: { mode: "local" }` for trusted local usage. `authMiddleware` requires authenticated mode; it cannot silently select a local gateway. For hosted Socket.IO, middleware verifies credentials and stores trusted state in `socket.data`. Middleware must call `next`; synchronous throws and returned promise rejections deny access with a generic error. Admission waits for any returned promise to settle, and duplicate `next` calls cannot admit twice. The gateway re-resolves identity and calls the host authorizer for every run, cancellation, discovery or tool lookup:

```ts
createAgentGateway({
  io,
  registry: false,
  agents: { assistant: agent },
  authMiddleware: verifySocketCredentials, // host function populating socket.data
  security: {
    mode: "authenticated",
    resolveIdentity: (verifiedState) => identityFromVerifiedState(verifiedState),
    authorizeResource: ({ identity, operation, resource }) =>
      authorizeSocketResource(identity, operation, resource),
  },
  maxConcurrentRuns: 4,
  maxOutputBytes: 256 * 1024,
  textStream: { maxFrameBytes: 256 * 1024, maxBufferedBytes: 256 * 1024, writeTimeoutMs: 10_000 },
});
```

`authorizeResource` must return exactly `true` to allow a resource. `execute` checks the named Agent, Team or Workflow. `session:create` must atomically bind the server-generated opaque session ID to the verified actor/tenant before returning; `session:use` must reject unknown, ownerless or other-tenant IDs. ID possession conveys no authority. Discovery calls `discover` separately for each named Agent, Team, Workflow or tool and omits denied entries. `run:cancel` applies after the gateway checks that the run belongs to this socket and its current verified actor. Never derive this policy from a client room or client identity claim.

Authenticated run payloads reject `userId`, `tenantId`, `runId`, `room` and `apiKey`. Handshake keys are not forwarded to providers in authenticated mode. Credentials come from host-configured runtime/provider objects. Client `sessionId` is only an ownership-checked reference. Local mode retains per-run API keys; new sessions are generated rather than using socket IDs.

Existing `agent.run`, `team.run`, `agent.chunk`, `agent.tool.call`, `agent.tool.done`, `agent.done` and `agent.error` names remain. `workflow.run` is available for workflows supplied through `serve` or the registry. Every admitted execution receives a generated `runId`; run events include `runId` and, after ownership binding, `sessionId`. The additive `agent.started` event supplies both IDs before runtime work starts. Concurrent clients must correlate events by `runId`. Send `run.cancel` with `{ runId }`; its acknowledgement is `cancellation_requested`, and an error terminal is emitted only after runtime/iterator cleanup settles.

Ordinary text HTTP and socket runs are connection-owned. Disconnect aborts their signal, initiates iterator return, and prevents late results. Agent/Team SSE uses one shared writer, waits for Node drain before pulling the next chunk, bounds individual encoded frames and queued bytes (256 KiB each by default), and applies a 10-second drain deadline. Socket output is serialized per connection, with the same configurable bounds and Engine.IO transport readiness; final collected Agent text has its own byte cap. Slow or oversized output cancels production; if a bounded terminal cannot be delivered, the connection closes. Configure the Socket.IO server's `maxHttpBufferSize`, HTTP body limits and deployment connection/time limits separately.

Cancellation is cooperative: arbitrary host callbacks cannot be force-killed, and disconnect does not undo effects. Cleanup promises are observed; no terminal success is published while owned work is unresolved. Durable task watchers retain their separate persisted lifetime. The in-memory `SSEEventLog` only provides process-local replay and does not persist execution; multiline strings are encoded as separate SSE data lines and event names reject line injection.

Multipart uploads bound file count/size plus text field count/size (`maxFields: 32`, `maxFieldSize: 64 KiB` defaults). The selected patched Multer peer is required even when only local fixtures are used; transport limits do not repair a vulnerable installed parser. Aborted and malformed upload tests use small local requests and assert completion, bounded limits and released file buffers.

### Voice gateway acknowledgement migration

Voice gateways now reserve pending connections, cancel disconnected setup, and bound queued output. Auth middleware establishes identity in `socket.data.auth`; client user/session/key overrides are ignored when authentication is enabled. The client must acknowledge `voice.audio` sequence numbers through `voice.playback.ack`, clear playback on `voice.clear`, and send `voice.playback.complete` only after a generation has actually played. Defaults are 256 KiB per frame, 1 MiB pending output, and a 10-second acknowledgement deadline. Missing acknowledgements terminate the session rather than growing buffers. See the [voice guide](../core/src/voice/README.md) for the event contract, format negotiation and playback-confirmed history.

## A2A 1.0 and legacy migration

Install the optional `@a2a-js/sdk` peer (tested with 1.3.0). `createA2AV1Server` uses A2A1.0 JSON-RPC and `/.well-known/agent-card.json`; `A2AV1Client` is exported by core. The older `createA2AServer` / `A2ARemoteAgent` implementation remains available. Use `createA2AServer` for its server export; the redundant server alias has been removed. The client also has the explicit `A2ALegacyRemoteAgent` name. Mount the legacy endpoint separately during migration.

```ts
import { createA2AV1Server } from "@agentium/transport";

await createA2AV1Server(app, {
  agents: { assistant },
  url: "https://agents.example/rpc",
  audience: "agentium-service",
  authenticate: async (request, audience) => {
    // Host verifier validates signature, issuer, expiry and this audience.
    const claims = await verifyAccessToken(request.headers.authorization, audience);
    return claims ? { tenantId: claims.tenantId, userId: claims.subject } : null;
  },
  maxTasks: 10_000,
  maxHistoryMessages: 128,
});
```

Verified tenant and actor own tasks. Body tenant overrides cannot change that identity. Text, structured JSON and PNG/JPEG/WebP raw bytes or HTTP(S) image references are accepted. Inline image URLs should use the raw-byte part instead; local paths and other URL schemes are rejected. The host remains responsible for remote media access policy in its model adapter. A structured Agent result becomes a typed artifact. `completionState` maps domain-specific results to input-required or authentication-required interruptions.

Cancellation waits for owned Agent work to settle before reporting canceled; late success cannot overwrite it. A non-cooperative callback may delay acknowledgment. Capacity is enforced before task admission and in the backing store, with bounded history and one active writer per identity/session. Exhaustion rejects new work; retention is process-local and is reset on restart, with no durable recovery claim.

The client restricts credential-bearing discovery/requests to the configured origin, rejects redirects and supports per-call abort while sharing discovery. Paid providers are not required for the protocol conformance tests. Legacy clients propagate cancellation and close SSE readers on early exit; legacy streaming servers abort work on disconnect, bound outgoing buffering, and cap process-local tasks with `maxTasks`. Failed Agent outputs stay failed. Legacy authentication and task-owner isolation remain host middleware responsibilities; use the 1.0 adapter for built-in verified ownership.

## Durable task control and event replay

`createDurableTaskRouter({supervisor, records, authenticate, authorize, wake})` serves already-admitted durable tasks. Mount it under an application-owned prefix. The supervisor and record service must share the same `JournaledDurableTaskStore` instance. Host authentication supplies tenant/actor identity, and authorization rechecks current grants on every request. These routes return 404 for inaccessible tasks and keep inputs, action arguments, internal failure text and blob keys private.

- `GET /:taskId` returns task ID, state, revision and update timestamp.
- `POST /:taskId/cancel` persists cancellation, then invokes the host wake callback. Its 202 response reports the current state and `deliveryPending` if delivery failed. Retry wake through host recovery; cancellation is acknowledged only after reconciliation/settlement.
- `GET /:taskId/events` returns one bounded SSE replay batch and closes. Reconnect with `Last-Event-ID`; malformed cursors return 400, retention/future-cursor gaps return 409 with retained bounds. Authentication and policy are checked again on reconnect. Event data is intended for the owning actor; apply any required content redaction before appending it.

The router is an Agentium control API, separate from the named A2A/MCP wire adapters. It does not claim that an existing process-local protocol server becomes restart-safe when mounted beside it.

## Durable A2A and MCP Tasks bridges

`createDurableA2AV1Server` and `createDurableMCPTaskHandler` are opt-in adapters over the same durable supervisor. They do not use the ordinary A2A server's process-local task store. Install the optional peers `@a2a-js/sdk` (tested at **1.3.0**) and/or `@modelcontextprotocol/server` (tested at **2.3.0**). Construction dynamically loads only the selected SDK; importing the package does not connect to a database or protocol server.

Both adapters require a `DurableProtocolHost`: `supervisor`, `admit`, `authorize`, and `wake`. Authentication additionally verifies credentials for an explicit audience and returns `{tenantId, actorId}`. Every task lookup checks both fields and current host policy. `authorize` receives `read`, `cancel`, `input`, or `wake`; missing callbacks fail construction. Protocol metadata never supplies identity, policy revisions, grants, manifests, or driver registrations.

```ts
import { DurableActionLedger } from "@agentium/core";
import {
  createDurableA2AV1Server,
  createDurableMCPTaskHandler,
  type DurableProtocolHost,
} from "@agentium/transport";

const host: DurableProtocolHost = {
  supervisor,
  async admit(identity, payload) {
    // Application service: validate current policy, select registered driver,
    // bind identity/manifest/input/budget/grant refs, and persist atomically.
    // For retries, deduplicate A2A messageId and any application idempotency key.
    return admission.persist(identity, payload);
  },
  authorize: (identity, task, operation) => policy.authorize(identity, task, operation),
  wake: (key) => durableQueue.wake(key),
  async respond(identity, task, response) {
    // Your human-consent service must reject automated/model-originated approval.
    await consent.verify(identity, task, response);
    await DurableActionLedger.decide(supervisor.store,
      { tenantId: identity.tenantId, taskId: task.id },
      { ...response, actorId: identity.actorId });
  },
  // Only public text/JSON leaves the host. Resolve artifact references with
  // DurableRunRecords and the same verified identity before projecting output.
  output: (identity, task) => publicResults.read(identity, task),
};

app.use(await createDurableA2AV1Server({
  ...host,
  name: "assistant",
  url: "https://agents.example/rpc",
  audience: "agentium-service",
  authenticate: (request, audience) => auth.verify(request.headers.authorization, audience),
}));

const mcp = await createDurableMCPTaskHandler({
  ...host,
  name: "assistant",
  audience: "agentium-service",
  authenticate: (request, audience) => auth.verify(request.headers.get("authorization"), audience),
  tools: [{ name: "research", inputSchema: {
    type: "object", properties: { query: { type: "string" } },
    required: ["query"], additionalProperties: false,
  } }],
});
// Mount mcp.fetch(request) using your runtime's web-standard Request/Response adapter.
// On shutdown: await mcp.close().
```

`admission`, `policy`, `consent`, `auth`, `publicResults`, and `durableQueue` above are host services, not implicit Agentium globals. Admission must complete persistence before returning `{tenantId, taskId}`. The bridge verifies that record's owner before responding and separately authorizes wake delivery. A failed queue delivery does not erase the admitted task, approval decision, or cancellation intent; the host must retry delivery. For a Mongo-backed deployment use the durable store's majority/CAS adapter, not a generic `StorageDriver`. In-memory stores keep their non-durable capability flag.

A2A supports **1.0 JSON-RPC `SendMessage`, `GetTask`, and `CancelTask`** with text/JSON input and projected text/JSON artifacts. The card advertises `streaming: false` and `pushNotifications: false`; streaming, subscriptions, task listing, extended cards, and push configuration are rejected. New context IDs come from admission. Existing-task input is one JSON part `{approvalId, preparedHash, approved}`; it must match an outstanding durable approval. Default blocking `SendMessage` waits for a terminal/interrupted state. `configuration.returnImmediately: true` returns the admitted task immediately; the default 30-second wait limit raises a protocol error containing the task ID, leaving the task available through `GetTask`. `CancelTask` reports canceled only after supervisor acknowledgement; a timeout reports pending cancellation as an error, and `GetTask` remains working with `metadata.cancellationRequested` until acknowledged.

MCP supports **2026-07-28** HTTP framing and the [`io.modelcontextprotocol/tasks` extension](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html). The official SDK handles discovery/tool listing and schema validation; this adapter implements `tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel`. Each modern request must have the validated protocol envelope, matching protocol/method/name headers, and the Tasks capability. A missing capability, unsupported revision, unsupported method, or invalid argument is rejected before admission. Polling is supported; task notifications/subscriptions, task listing, legacy task shapes, and legacy HTTP sessions are not. Named ordinary/legacy adapters remain separate and unchanged.

A pending human decision maps to `input_required` with a stable approval ID and prepared digest. MCP input responses use `{[approvalId]: {action: "accept", content: {approved, preparedHash}}}`; decline/cancel deny the approval. Already answered or unknown keys are ignored, and `respond` must be installed explicitly. Approved/denied input awaiting worker pickup returns working. MCP cancellation acknowledges persisted intent with `resultType: "complete"`; polling remains working until cancellation is acknowledged. Completed projections may set `isError: true` for a domain/tool error while remaining protocol-completed. Internal execution failures expose only a generic protocol error; stored failure text stays private.

Request and projected task payloads are bounded to 64 KiB, with depth/node limits. A2A messages accept at most 32 parts; MCP exposes at most 128 distinct tools. Files, raw media, arbitrary artifact URLs, internal inputs/action arguments, and blob keys are never automatically serialized. Larger results require a host-owned retrieval API. The host supplies request rate/concurrency limits and task retention; MCP returns `ttlMs: null` because this bridge does not own expiration. Durable SSE event replay is provided by `createDurableTaskRouter`, separately from these polling protocol endpoints.

For MCP client recovery, `MCPV2ToolProvider.exportTaskReference(handle, ctx)` produces a credential-free reference for host-owned storage. After client restart, `resumeTask(reference, ctx)` verifies the provider/endpoint and tenant/user/session identity, fetches the remote task under current credentials, and returns a fresh local handle for the new run. HTTP Tasks and explicit tenant/user identity are required. Do not expose references or approval controls as ordinary model tools.

Local HTTP fixtures exercise the actual pinned SDKs, ownership, negotiation, approval digest binding, cancellation, projected artifacts, and compatibility with the existing adapters. The opt-in `AGENTIUM_DURABLE_MONGO_TEST=1` fixture creates a random isolated database, closes the original store, recreates protocol servers over a new store client, and verifies approval/completion/cancellation reads. These are scoped interoperability checks for the implemented methods, not full protocol certification, external deployment approval, or exactly-once execution guarantees.
