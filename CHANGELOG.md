# Changelog

All notable changes to this project will be documented in this file.

## [3.1.1] - 2026-09-19

### Added
- **`run({ questions })` for Jev.** Pass `choice` / `noul` / `score` on each `agent.run()` / `agent.stream()`. Per-run questions win over `jev(model, { questions })`.

### Fixed
- **Jev `structuredOutput` scores.** TypeSafe often returns a fractional expected index. Flattening now `Math.round`s it so `z.number().int().min().max()` parses into `result.structured`.
- **Biome 2.5.14.** Schema/preset migration, Azure OpenAI format, and the artifact test optional-chain error so `biome ci` passes.
- **Package types.** `tsc --emitDeclarationOnly` replaces tsup `--dts` (rollup-plugin-dts crashes on TypeScript 5.7). CJS and ESM both resolve `.d.ts`.

## [3.1.0] - 2026-09-19

### Added
- **Jev (TypeSafe System One).** `jev("jev-latest")` is a `ModelProvider` for `new Agent({ model })` — decisions, not chat. Pass `questions` (`choice` / `noul` / `score`), or derive them from `structuredOutput` (enums / booleans / bounded numbers) or closed-set tools. `JevToolkit` (`@agentium/core/toolkits`) exposes `jev_choose`, `jev_score`, `jev_noul`, `jev_ask`, and optional `jev_evaluate` packs on a chat agent. Requires optional peer `@typesafe-ai/sdk` and `TYPESAFE_API_KEY`.

## [3.0.2] - 2026-09-17

### Fixed
- **GPT-5.6 / GPT-6 function tools.** Chat Completions rejects function tools unless `reasoning_effort` is `none` (GPT-5.6 defaults to medium when the field is omitted). OpenAI, Azure OpenAI, openai-compatible gateways (xAI, Vercel, DeepSeek, Meta, LiteLLM), Azure Foundry, and the OpenAI-compat fallbacks for Mistral / Cohere / Perplexity now send tools + reasoning through `/v1/responses`, and fall back to Chat Completions with `reasoning_effort: "none"` when Responses is unavailable.
- **Claude / Gemini tools + thinking.** Anthropic, AWS Claude, Gemini, and Vertex already allow tools with thinking on their native APIs — they do not use `reasoning_effort`. They still 400 if the next turn drops thinking signatures. Agentium now replays Anthropic `thinking` / `redacted_thinking` blocks (with signatures) and Gemini `thoughtSignature` parts through the tool loop.

## [3.0.1] - 2026-09-17

### Fixed
- **Debug logging.** `logLevel: "debug"` now prints real tool arguments (it previously logged `{}`), pretty-prints JSON instead of slicing it at 200/300 characters, and drops the noisy per-loop token-count lines that cluttered the CLI. Override the body cap with `new Logger({ maxPayloadChars })`.

## [3.0.0] - 2026-09-17

A deletion release. Nothing was added. The main `@agentium/core` bundle drops from
593.8 KB to 363.8 KB (ESM, unminified) — 39% smaller — because toolkits moved behind
their own entry point and modules that only ever stored data got removed.

Full upgrade notes: https://agentium.in/migration-v3

### Breaking

- **Toolkits moved to `@agentium/core/toolkits`.** All 30 concrete toolkits, their config
  types, and `toolkitCatalog` / `ToolkitCatalog` now live behind a subpath export so
  `import { Agent }` no longer pulls every integration into the bundle. Individual
  toolkits are importable on their own (`@agentium/core/toolkits/github`). The base
  abstractions — `Toolkit`, `collectToolkitTools`, `describeToolLibrary`, `ToolkitMeta`,
  `ToolkitConfigField` — stay at the root, so writing your own toolkit does not require
  the entry point holding all the first-party ones.
- **`learning: true` no longer accepted.** `learning` takes a `LearningsConfig` with a
  real `vectorStore`. Passing `true` used to allocate a throwaway in-memory store that
  looked persistent and was not. `Agent.deep()` no longer enables learning implicitly.
- **Removed modules:** `capacity/*` (`planCapacity`, `SessionProfiler`, `kv-estimator`,
  `latency-estimator`, `infra-cost`, `architectures`), `compliance/*` (`AuditLogger`,
  `ComplianceReporter`, `ErasureManager`, `RetentionManager`), `versioning/*`
  (`VersionStore`, `ABRouter`, `ShadowRunner`), `scheduling/*` (`AgentScheduler`),
  `culture/*` (`CultureManager`), `Memory`, `UserMemory`, `FlashMemoryStore`,
  `ContextCurator`, `LearnedSkillStore`, and `SemanticToolSelector`. These stored state
  and emitted events, but nothing in the agent loop ever read them back.
- **Removed `AgentConfig` fields:** `generateFollowups` (and `RunOutput.followupSuggestions`),
  `culture`, `contextCurator`, `versioning`, `compliance`, `tenant`, and `rateLimit`.
  Each was accepted and then ignored, or pointed at a module listed above. Multi-tenancy
  and rate limiting themselves are unchanged — `AgentFactory`, `ScopedStorage`,
  `TenantScopedStorage`, `TokenRateLimiter`, and `ConcurrencyLimiter` all remain.
- **Removed 41 never-emitted `AgentEventMap` keys**, leaving 37 real events. Subscribing
  to one of the removed keys previously gave you a handler that never fired; a bad event
  name is now a type error.

### Changed

- `fileMemory` and `filesystem` reuse `memory.storage` when they do not declare their own,
  instead of each defaulting to a separate `InMemoryStorage`.
- `@agentium/core` is marked `sideEffects: false` and built with code splitting and
  tree shaking enabled.
- Export conditions now resolve `.d.cts` for `require` and `.d.ts` for `import`, so CJS
  consumers get correct types.
- Every package declares `publishConfig.access: "public"`.

### Kept deliberately

Storage drivers stay in `@agentium/core`. `InMemoryStorage`, `SqliteStorage`,
`PostgresStorage`, `MongoDBStorage`, `RedisStorage`, `MySQLStorage`, and
`DynamoDBStorage` are unchanged; their database clients are optional peer dependencies,
so an unimported driver costs nothing.

## [2.7.0] - 2026-09-16

### Added
- **Agent harness** on `Agent` (no separate DeepAgent class): `workspace`, `skillDirs` (`SKILL.md`), `contextFiles` (`AGENTS.md`), durable `filesystem` notes, `fileMemory` (MEMORY.md / USER.md), `subagents` (`task` tool), `learning: true` (wraps existing vector learnings), `searchPastSessions`, `sharedEventBus`, and `Agent.deep()` preset.
- **EventBus** `onAny`, `EventBus.shared` / `resetShared`, `LIFECYCLE_EVENTS`, and `subagent.*` events. Use hooks to steer a run — the bus is for watching.

### Deprecated
- `Memory`, `UserMemory`, and `CultureManager` overlap the new file + unified memory layers. Prefer `memory`, `fileMemory`, `learning`, and `contextFiles`.

## [0.3.41] - 2026-03-01

### Added
- **`providerMetrics` on `TokenUsage`** — Every usage object now includes raw, unmodified metrics from the underlying provider API. OpenAI returns `prompt_tokens_details`, `completion_tokens_details`; Vertex/Google returns `thoughts_token_count`, `traffic_type`, `prompt_tokens_details`; Anthropic returns `cache_read_input_tokens`, `cache_creation_input_tokens`. Fully transparent — no data is lost.
- **Enriched `RunOutput` response** — Every `agent.run()` and `agent.stream()` now returns detailed metadata matching Agno-level detail:
  - `runId`, `agentName`, `sessionId`, `userId` — Run identity
  - `model`, `modelProvider` — Which model/provider was used
  - `status` — `"completed"` | `"error"` | `"stopped"`
  - `createdAt` — Epoch timestamp
  - `timeToFirstTokenMs` — Time to first token from the model
  - `durationMs` — Total wall-clock time for the run
  - `messages` — Full conversation sent to the LLM (system + history + user input)
  - `metrics` — Structured `RunMetrics` with `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedTokens`, `timeToFirstTokenMs`, `durationMs`
  - `responseId` — Provider-assigned response ID (e.g., OpenAI `chatcmpl-*`)
- **`providerMetrics` propagated across all packages:**
  - **Transport**: Socket.IO gateway now captures `usage` from stream finish chunks (previously dropped); voice gateway includes `providerMetrics`; Swagger schema updated
  - **Observability**: Tracer spans, structured logger, metrics exporter, and Langfuse exporter all forward `providerMetrics`
- **`RunMetrics` type export** — New `RunMetrics` interface exported from `@radaros/core`
- **All 14 model providers** — `providerMetrics` populated in both `generate()` and `stream()` paths: OpenAI, Anthropic, Google, Vertex AI, Azure OpenAI, Azure Foundry, AWS Bedrock, AWS Claude, Ollama, DeepSeek, xAI, Meta Llama, Vercel, Perplexity, Mistral, Cohere

### Fixed
- **Vertex AI / Google `systemInstruction` silently dropped** — The `@google/genai` SDK requires `systemInstruction` inside the `config` object, not as a top-level parameter. RadarOS was passing it at the top level, causing Gemini to ignore system prompts and report `promptTokens: 1`. Fixed in both `VertexAIProvider` and `GoogleProvider`.
- **Socket.IO gateway dropped `usage` on stream** — `agent.done` event only sent `{ text }`, discarding all token usage data. Now sends `{ text, usage }`.
- **Edge package sandbox failures (13 tests)** — `os.uptime()` and `os.networkInterfaces()` throw `EPERM` in sandboxed environments. Wrapped in try/catch with graceful fallbacks. All 72 edge tests pass.

## [0.3.18] - 2026-02-26

### Added
- **`maxTokens` option on `AgentConfig`** — Caps output tokens per LLM call, wired through all `LLMLoop` construction sites.
- **`costTracker` option on `VoiceAgentConfig`** — Voice sessions now track token usage.
- **`usage` event on `RealtimeEventMap`** — OpenAI Realtime `response.done` usage data flows through the voice pipeline.
- **`voice.usage` Socket.IO event** — Real-time cost updates on the client via the voice gateway.
- **Pricing entries** for `claude-sonnet-4-6` and `claude-haiku-4-5-20251001` in `cost/pricing.ts`.
- **`@radaros/admin` and `@radaros/edge` publish steps** in CI workflow.

### Fixed
- **SessionManager deadlock** — `appendMessages()` and `updateState()` called `getOrCreate()` inside a locked section, which re-acquired the same non-reentrant lock causing a deadlock (15s test timeouts). Extracted private `_getOrCreate()` to avoid re-entrant locking.
- **Voice transcript word-by-word bubbles** — Each `voice.transcript` delta created a new message div; now accumulates into a single bubble per turn.
- **Zero token count in UI** — Missing pricing entries for newer Anthropic model names; voice agent had no cost tracker.
- **Release script missing packages** — `scripts/release.mjs` only bumped 5 of 9 packages; added `admin`, `edge`, `eval`, `observability` to both `PACKAGES` and `PEER_DEP_FILES`.
- **Publish workflow missing packages** — Added `@radaros/admin` and `@radaros/edge` to `.github/workflows/publish.yml`.
- **Package version drift** — Synced `admin` (0.3.14), `edge` (0.3.14), `eval` (0.1.0), `observability` (0.1.0) to 0.3.18.

## [0.3.14] - 2026-02-27

### Added
- **`@radaros/edge` package** — New package for running AI agents on Raspberry Pi and edge devices.
- **SystemToolkit** — CPU temperature, memory, disk, network info with zero native dependencies. Reads `/proc/`, `/sys/`, and `os` module.
- **GpioToolkit** — GPIO read, write, edge watch, and software PWM via `node-libgpiod`. Pi 5 compatible (chip 4).
- **CameraToolkit** — Photo capture, video recording, and MJPEG streaming via `libcamera-still`/`libcamera-vid`. Zero native deps.
- **SensorToolkit** — I2C sensor reading (BME280 temperature, humidity, pressure) via `i2c-bus`.
- **BleToolkit** — Bluetooth Low Energy scan, connect, read/write characteristics, and notifications via `@stoprocent/noble`.
- **ServoToolkit** — Hobby servo control via GPIO PWM with configurable pulse widths and sweep.
- **EdgeRuntime** — Watchdog (auto-detect unresponsive agents), resource monitor (CPU temp, memory, disk thresholds), graceful degradation, and HTTP health endpoint.
- **Edge Presets** — `edgePreset("pi4-4gb")`, `edgePreset("pi5-8gb")`, etc. with optimized defaults for each device class.
- **Ollama Edge Helpers** — `ensureOllama()`, `pullModel()`, `recommendModel(ramMb)`, `hasModel()` for local LLM management.
- **EdgeCloudSync** — Heartbeat, config pull from cloud admin API, event push, and offline-first local queue (JSONL).
- **`registerEdgeToolkits()`** — Register all 6 IoT toolkits in the global `toolkitCatalog` for Admin UI discovery.
- **`"iot"` category** — New toolkit category in `ToolkitMeta` for IoT/edge toolkits.

## [0.3.13] - 2026-02-27

### Added
- **Toolkit Catalog** — `toolkitCatalog` singleton in `@radaros/core` with metadata for all 18 built-in toolkits: config fields, secret markers, env var names, categories. Powers UI-driven toolkit browsing.
- **Toolkit Config CRUD** — `ToolkitManager` in `@radaros/admin` manages toolkit credentials: save, update, delete configs with automatic secret masking in responses.
- **Dynamic Toolkit Instantiation** — Save a toolkit config with `enabled: true` and its tools immediately become available for agent creation. Hydration restores configs on restart.
- **Tool Discovery Endpoints** — `GET /tools`, `GET /tools/:name` (Express) and `tools.list`, `tools.get` (Socket.IO) in both transport and admin layers. UI can discover available tools before creating agents.
- **`toolkits` option** — Pass `Toolkit[]` to `createAdminRouter()`, `createAdminGateway()`, `createAgentRouter()`, `createAgentGateway()` to auto-populate the tool library from toolkit instances.
- **`collectToolkitTools()`** — Utility to convert toolkit instances into a named `Record<string, ToolDef>`.
- **`describeToolLibrary()`** — Converts a tool library into a serializable array of `{ name, description, parameters }`.
- **Toolkit Catalog + Config events** — Socket.IO events: `admin.toolkit-catalog.list`, `admin.toolkit-catalog.get`, `admin.toolkit-config.create/list/get/update/delete` with real-time broadcasts.
- **EntityFactory dynamic tool source** — `EntityFactory` now accepts a function for dynamic tool resolution, keeping the tool library in sync with active toolkit configs.

## [0.3.12] - 2026-02-27

### Added
- **Live Auto-Discovery** — Agents, Teams, and Workflows auto-register into a global `Registry` on construction. Transport layers (Express, Socket.IO) discover them dynamically at request time — zero-wiring setup.
- **Registry API** — `Registry` class with `add`, `remove`, `getAgent`, `getTeam`, `getWorkflow`, `list`, `describeAgents`, `describeTeams`, `describeWorkflows` methods.
- **`serve` option** — Pass a mixed `Servable[]` array to `createAgentRouter()` / `createAgentGateway()` instead of separate `agents`/`teams`/`workflows` maps.
- **List Endpoints** — `GET /agents`, `GET /teams`, `GET /workflows` return rich metadata. `GET /registry` returns all registered names. Matching Socket.IO events: `agents.list`, `teams.list`, `workflows.list`, `registry.list`.
- **`kind` discriminant** — `Agent`, `Team`, and `Workflow` classes expose a `readonly kind` property for reliable runtime type identification.
- **Tool Strict Mode** — `defineTool({ strict: true })` enables OpenAI Structured Outputs on tool calls, guaranteeing valid JSON responses.
- **Schema Optimization** — Tool JSON Schema serialization now strips verbose fields (`$schema`, `additionalProperties`) to reduce token overhead.
- **Observability** — New `@radaros/observability` package with tracing, metrics, and structured logging
- **Eval Framework** — New `@radaros/eval` package for agent output testing and scoring
- **Agent Handoff** — Built-in tool for mid-conversation agent transfers with cycle detection
- **Cost Tracking** — Token budgets, per-run/session/user cost limits
- **Semantic Cache** — Vector-based response caching with configurable similarity threshold
- **Webhooks** — HTTP, Slack, and email event destinations with batching and retry
- **CORS & Rate Limiting** — Built-in middleware for transport layer

### Fixed
- PgVector SQL injection in metadata filter keys
- MongoDB regex injection in storage prefix queries
- Session manager race conditions with concurrent writes
- Agent constructor async initialization race
- Tracer memory leak (unbounded trace/metrics storage)
- Tool span key collision on repeated tool calls
- Anthropic streaming always reporting 0 prompt tokens
- OpenAI o-series models using wrong max_tokens parameter
- 10 silent catch blocks across voice/browser paths
- Webhook listener leak on detach
- Eval suite aborting on single case failure

### Improved
- Retry logic with exponential backoff for all model providers and embedding APIs
- Client cache LRU eviction (capped at 50 entries per provider)
- Entity memory deduplication with 50-item caps
- Per-session locking prevents concurrent write corruption
- Skill manager error isolation (one failing skill doesn't block others)
- BM25 tokenizer supports Unicode (international text)
- JsonFileExporter uses async I/O
- Langfuse/OTel exporters retry on 5xx with timeout
- Transport input validation on all endpoints

## [0.3.11] - 2026-02-25

### Added
- Unified Memory System (summaries, user facts, user profile, entity memory, decision log, learned knowledge)
- Skills System with learned skill store and remote skill loading
- BrowserAgent with Playwright integration
- VoiceAgent with OpenAI Realtime and Google Live

## [0.3.0] - 2026-02-20

### Added
- Initial release with Agent, Team, Workflow orchestration
- Multi-model support (OpenAI, Anthropic, Google, Ollama, Vertex)
- Express and Socket.IO transport
- BullMQ background job processing
- Session management with pluggable storage
