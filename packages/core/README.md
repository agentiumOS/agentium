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
- **30+ built-in toolkits** — Calculator, GitHub, Slack, Jira, Notion, SQL, and more. Import them from `@agentium/core/toolkits` (or `@agentium/core/toolkits/github`) so `import { Agent }` does not pull every integration. `toolkitCatalog` lives on the same entry.
- **Auto-Discovery** — Agents, teams, and workflows auto-register into a global `Registry`; transport layers discover them dynamically
- **Memory** — Unified memory system with summaries, user facts, entity memory
- **Teams & Workflows** — Multi-agent coordination with handoffs
- **Streaming** — First-class streaming support
- **Guardrails** — Input/output validation
- **Cost Tracking** — Token budgets and cost monitoring
- **Semantic Cache** — Vector-based response caching

## Agent and harness ownership

`new Agent(...)` configures core agent execution: model, tools, messages and explicitly requested services. The optional [`@agentium/harness`](../harness/README.md) package owns definitions, abilities, composition, runtime, controllers, context/completion policies, drivers and their resource lifecycle. Core has no dependency on that package.

Use `HarnessRuntime({ definition, driver: agentDriver(config), ... })` for a harness-owned Agent, or pass an already configured Agent to borrow it. Agent-specific definition defaults apply only to the configuration form. Core's neutral `ExecutionServices` port supplies model/tool operations, authorization, cancellation and owned work; it contains no harness definitions, controllers or manifests. Application callers normally let a driver supply that port.

`Agent.deep()`, `AgentConfig.harness`, `harnessOptions`, `replaceTools` and `harnessDescription` were removed in 4.0.0. Explicit workspace configuration requires `{path, mode: "read" | "write"}`. Ordinary Agent options remain available; the [harness migration guide](../harness/README.md) shows the removed deep preset's behaviors as explicit choices. Stored conversation readers and public Zod 3 tool schemas remain supported.

Borrowed approval dispatchers stay open when an Agent closes. `Agent.close({closeStorage:false})` releases Agent-owned resources while leaving a supplied storage client with its host; harness-owned Agent drivers use this mode. Ordinary `close()` retains its existing storage-close behavior.

## Execution policy and approvals

`AgentConfig.executionPolicy` is a mandatory host boundary over Zod-validated calls. Its `decide(call, ctx)` returns `{ action: "allow" | "ask" | "deny", reason?: string }`. An inherited policy and an executor's local policy both apply; a tool cannot override a deny. Authorization also runs before cache hits and result transformations.

```typescript
const agent = new Agent({
  name: "workspace-assistant",
  model: openai("gpt-4o"),
  workspace: { path: "./project", mode: "read" },
  approval: { policy: "none" }, // Dispatcher for explicit tool/policy requests.
  executionPolicy: {
    decide: (call) => ({ action: call.toolName.startsWith("fs_") ? "allow" : "ask" }),
    resolveEffect: (call) =>
      ["fs_read_file", "fs_list_directory", "fs_file_info"].includes(call.toolName) ? "read" : "unknown",
  },
});
await agent.run("Inspect the project", { sessionId: "review", runMode: "plan" });
```

Use a host-owned effect resolver; model arguments and MCP annotations are not classification authority. Immutable `runMode: "plan"` permits classified reads, denies write/execute/external effects, and requires approval for unknown effects. It does not sandbox arbitrary JavaScript inside a tool. Classify the tool's entire execution, including its result transformer.

An explicit `requiresApproval: true` (or true predicate), or a policy `ask`, now fails closed when no approval service is configured. Legacy `requiresApproval: false` still exempts a tool from the legacy approval policy; use `executionPolicy` for mandatory rules. Arguments changed by approval observers or pre-execution hooks must be authorized again through a new invocation.

The stable `agent.approvalManager` facade reaches pending run, stream, and dynamically added tool requests. Use `approve(requestId)`, `deny(requestId)`, and `listPending({ tenantId, userId, sessionId, runId })`; scope fields are optional filters. A request is registered before `tool.approval.request` fires, so synchronous decisions work. Unfiltered access is for the trusted host. Hosted ownership authorization is separately required; see the transport README. Cancellation and agent close revoke pending requests.

`VoiceAgent` accepts `approval`, `approvalManager`, and `executionPolicy`; skill tools use the same dispatcher. `connect` accepts `tenantId`, `signal`, and `runMode`. Pending tools are revoked on interruption, cancellation, or session close. This boundary covers local ToolDefs; provider-native MCP/tools are outside it.

Workspace paths require explicit `{ path, mode: "read" | "write" }` configuration. Use read mode to omit workspace write tools. Canonical checks reject external/dangling symlinks, including new paths under linked parents; internal links work. Overwrites use same-directory temporary files and rename. Append is not transactional, and canonical path checks do not protect against hostile concurrent filesystem replacement. These guarantees apply to the filesystem toolkit, not shell commands or arbitrary custom tools.

## Explicit workspace execution and cloud sandboxes

`SandboxAgent({backend: "unix-local"})` executes trusted programs on the host in an owned temporary workspace. It is not a security boundary. The unimplemented `"docker"` selector and `dockerImage` option were removed; stale JavaScript Docker configuration rejects before filesystem or process I/O. Use `backend: "remote"` with a configured cloud adapter for remote execution. Local file helpers validate paths and existing ancestors, but cannot confine arbitrary shell code or defend against hostile concurrent filesystem replacement.

Local execution passes code through interpreter arguments, limits captured output, supports cancellation, and waits for its process group's inherited output pipes to settle. Only PATH, explicit `inheritEnv` names, workspace variables and per-call variables enter the child environment. Call `start()` before use and `close()` to release the owned workspace. See the [sandbox contract and migration guide](src/sandbox/README.md) for snapshots, remote ownership, cancellation limits and exact SDK verification.

E2B uses optional `@e2b/code-interpreter ~2.8.0`; Daytona uses optional `@daytona/sdk ~0.220.0`. The old guessed `@e2b/sdk` and `@daytonaio/sdk` paths are no longer loaded. SDKs load at first use. Current adapters are verified with installed SDKs and local responses; live account execution requires separate operator authorization and cleanup verification.

## Provider continuations and history

Responses assistant messages carry a versioned `providerExtras.responsesReplay` envelope containing ordered output items and endpoint/model ownership. Opaque reasoning remains separate from display text. Generate and stream retain tool calls, matching results, and non-tool reasoning through both persistent memory and fallback sessions. `RunOutput.text` is display output; `RunOutput.messages` and stored session messages are the canonical transcript, including reflection revisions. Request compaction does not overwrite that transcript.

Legacy text-only sessions remain readable; missing historical reasoning cannot be reconstructed. Stored v3.2.0 `responsesReasoning` is accepted for the official OpenAI endpoint only. New envelopes reject an incompatible endpoint/model, and Responses continuations cannot silently downgrade to Chat Completions. Switching providers requires a new session or an explicit conversion implemented by the host; Anthropic/Gemini adapters reject foreign opaque continuations.

Fallback is allowed only before the first public stream chunk. Text, thinking, tool starts, and finish metadata each commit the attempt. An error after commitment propagates without appending another provider's output. Initial argument fragments are retained; malformed, interrupted, or unfinished tool streams execute no incomplete tools.

Compaction retains whole user turns with all tool rounds and provider extras. The latest turn remains intact; an indivisible turn exceeding the compactor budget raises `ContextCompactionError`. Summaries are historical assistant data, never standing system instructions. Session `maxMessages`/history limits are soft limits over whole turns: the latest turn can exceed them. Model input token trimming can drop an entire older turn but cannot split its tool exchange.

Regression fixtures cover ordered Responses generate/stream replay, official and custom endpoint ownership, legacy extras, initial Chat Completions arguments, Anthropic/Gemini replay, actual two-turn Agent persistence, and trim/summarize/hybrid compaction. Tests use synthetic SDK-shaped responses, not live provider credentials; they do not certify every model or compatible endpoint. Existing flat `providerOptions` remain supported.

## Documentation

Full docs at [docs.agentium.in](https://docs.agentium.in)

## Community

Join the conversation on [Discord](https://discord.gg/T86SJshP).

## License

MIT

### Incremental session snapshots

`IncrementalSessionManager` reads legacy array snapshots and writes `{ messages, nextSeq }` snapshots. The sequence watermark prevents duplicate replay if loose-entry cleanup fails, and session scans isolate IDs that share a prefix. Upgrade every reader/writer before sharing this storage with older Agentium versions; older versions cannot read the new snapshot shape. Operations serialize within one manager instance; shared multi-process storage still needs host coordination, and an append rejected after a partial storage failure may have persisted data.

### Verified local reranking

The optional cross-encoder loader was exercised with Transformers.js **4.3.0**, Node CPU inference, and the preloaded `Xenova/ms-marco-MiniLM-L-6-v2` artifact at revision `a09144355adeed5f58c8ed011d209bf8ee5a1fec`, **q8** ONNX precision. The integration test verifies relevance ordering and missing-artifact failure. It is a compatibility fixture, not a benchmark across languages/domains or GPU devices.

With the optional SDK installed and compatible weights already available:

```sh
AGENTIUM_TRANSFORMERS_MODEL=/absolute/path/to/model \
AGENTIUM_TRANSFORMERS_DTYPE=q8 \
npx vitest run packages/core/src/rerank/__tests__/cross-encoder-reranker.test.ts
```

Default tests skip this gate. Inference retains `localFilesOnly: true`; the test does not download models. Select the precision matching the preloaded ONNX filename (`fp32` is the fixture default when no precision is specified). A custom `pipelineFactory` owns alternate device/artifact behavior; those devices need their own certification.

### Incremental snapshot rollout

New incremental-session readers accept both legacy message arrays and `{messages,nextSeq}` snapshots. The latter prevents duplicated replay if cleanup fails after writing a snapshot. Upgrade **all readers** before allowing new snapshot writers, and keep a storage backup before changing the persisted format. To roll back, drain writers and restore the old reader-compatible snapshot/loose-message set together from the backup; do not simply extract `messages` and leave overlapping loose entries behind.

Run `npx vitest run packages/core/src/session/__tests__/incremental-session.test.ts` for legacy-array, watermark and failed-cleanup coverage. This does not provide cross-process locking for generic session/admin stores: hosts must serialize writers or select a CAS-capable adapter. Scope storage namespaces and retention by authenticated tenant/actor, including native voice memory. The durable task store is a separate opt-in API and does not change generic session-store concurrency semantics.

### Optional resources, handoff, calls and recovery

- Harness MCP context reads are configured with [`mcpResources`](../harness/README.md#approved-mcp-resources), explicit URI/MIME grants and host authorization.
- [`Agent.stream` handoff](src/handoff/README.md) follows target agents lazily while preserving canonical messages, settled tool results, policy and cancellation. Harness-controlled implicit Agent handoff remains guarded; an execution driver must own delegation when it owns the session and capabilities.
- [`@agentium/core/telephony`](src/telephony/README.md) supplies provider-neutral call intents and optional Twilio, Telnyx, Exotel, SignalWire, Vonage and LiveKit SIP adapters. HTTP providers use fetch ports; LiveKit uses structural host SDK clients. No telephony SDK is required to import core.
- [Live recovery](src/voice/README.md) is opt-in. Gemini uses safe session handles; OpenAI supports an explicit empty-session fallback. Uncertain tool effects require reconciliation. Recovery never replays input, tool actions or speech.

### Zod 3 and Zod 4 schemas

`defineTool`, `defineAsyncTool`, `ToolDef.parameters` and `AgentConfig.structuredOutput` accept standalone Zod 3, current Zod 4 Classic and Zod 4 Mini. Argument inference and runtime validation are preserved. Agentium uses Zod 4.6 internally with stable `zod/v3` imports for existing internal schemas; applications can keep their own Zod 3 dependency.

Use `parseSchema(schema, value)`, `safeParseSchema(schema, value)` and `schemaShape(tool.parameters)` when inspecting arbitrary public schemas. The widened `ToolDef.parameters` union includes Mini's core contract, so consumers should replace direct `.parameters.safeParse()` or `.parameters.shape` access with these helpers. `convertJsonSchema` retains input-shape conversion and reports runtime-only transformations/refinements; JSON Schema cannot enforce executable validation functions. Package fixtures verify actual Zod 3.25.76 and 4.6.5 in ESM/CommonJS consumers.

## OpenAI Decisions (4.1+)

Install `openai@^7.30.0` and set `OPENAI_API_KEY`. Use `openaiDecisions()` for typed classification, condition probabilities, and rubric scores.

```typescript
import { Agent, openaiDecisions } from "@agentium/core";

const agent = new Agent({ name: "triage", model: openaiDecisions() });
try {
  const result = await agent.run("I was charged twice.", {
    questions: [{ type: "predicate", name: "billing", instructions: "Does this concern billing?" }],
  });
  console.log(result.decisions);
} finally {
  await agent.close();
}
```

The default model is `gpt-6-luna`. A run question array replaces constructor defaults. Answers can include individual refusals; scores can be fractional. `stream()` emits completed JSON followed by a finish chunk containing `decisions`. Only text and inline base64 images are supported. Conversation roles become labeled text evidence in user messages; question instructions define the classification task. Tools, arbitrary output schemas, chat sampling options, and semantic caching are unsupported.

Costs use the `openai-decisions/gpt-6-luna` pricing key with a base input rate of $0.10 per million tokens. Regional and long-context premiums require custom pricing. See the [Decisions guide](https://docs.agentium.in/models/openai-decisions).
