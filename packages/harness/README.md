# @agentium/harness

A developer kit for building agent execution environments from explicit abilities, policies and drivers. `HarnessRuntime` owns composition, scoped resources, canonical conversation state, aggregate budgets, events and cleanup. Core `Agent` owns ordinary model/tool execution and consumes a neutral `ExecutionServices` port; it does not construct a harness or depend on this package.

Definitions can contribute tools, source context, prompt fragments and ordered middleware. Define, extend and inspect are synchronous and perform no filesystem scans, provider calls or client initialization. Binding and execution begin when the runtime starts a run.

## Build and use

Install matching versions of `@agentium/core` and `@agentium/harness`, plus your chosen provider SDK. This package has no required browser, queue or provider SDK dependency. ESM and CommonJS exports expose the same API. In this workspace:

```sh
npm run build:core
npm run build:harness
```

Use a definition with a driver and explicit host grants:

```ts
import { agentDriver, HarnessRuntime, research } from "@agentium/harness";

// model is the application's existing ModelProvider.
const definition = research({
  text: {
    id: "project-notes",
    entries: [{ id: "scope", text: "The project investigates shipping delays.", uri: "notes:project" }],
  },
});
const runtime = new HarnessRuntime({
  definition,
  driver: agentDriver({
    name: "research-assistant", model,
    instructions: "Answer questions using the supplied sources and cite them.",
  }),
  grants: { toolIds: [], modelRoles: ["main"] },
  budgets: { maxModelCalls: 4, maxToolCalls: 0, maxTokens: 8000 },
});
const result = await runtime.run("What is this project investigating?", {
  identity: { tenantId: verifiedTenant, userId: verifiedActor },
  sessionId: "research-42",
});
```

`research` performs no implicit web search. Text and files are labelled source data. Search and business tools come from the host, and their names must be granted before a model can use them. Identity comes from trusted application authentication, never model input.

## Agent ownership and configuration

`agentDriver(config)` creates one run-owned Agent, applies definition defaults outside core, and reuses that instance across follow-ups and completion revisions within that run. A different run gets a different Agent. The runtime closes the owned Agent once after owned work settles; cleanup failures are diagnostic and do not replace a primary failure. Host-supplied backing stores remain borrowed and are not closed by this driver.

`agentDriver(existingAgent)` borrows an already configured Agent. The host closes it. A definition with Agent defaults or limits is rejected for a borrowed Agent: choose one configuration owner. Abilities, runtime grants, budgets and policies remain available with a borrowed Agent when its definition has no Agent defaults or limits.

Explicit Agent configuration overrides definition defaults, including `false` to disable a feature. Definition limits cap configured Agent tool roundtrips and child depth; runtime `budgets` independently bound aggregate model/tool/token use across delegates and revisions. `projectRoot` is captured by the runtime and resolves relative workspace and skill paths. Portable manifest paths remain relative for hashing.

Canonical conversations belong to the runtime's session store. The Agent adapter supplies history through the neutral execution-services port and uses ephemeral Agent session semantics, avoiding duplicate session persistence or automatic memory extraction. Explicit memory tools and standing notes are separate capabilities. Tenant/user identity on a run does not automatically namespace an arbitrary host storage client: provide tenant/actor-scoped stores and clients, and keep their shutdown with the host.

## Explicit migration from Agent.deep

`Agent.deep()`, `AgentConfig.harness`, `harnessOptions`, Agent `replaceTools`, and the `legacyDeep` preset are removed. There is no hidden replacement preset. The old choices can be written as a normal definition, then adjusted or deleted individually:

```ts
import { InMemoryStorage } from "@agentium/core";
import { agentDriver, defineHarness, HarnessRuntime } from "@agentium/harness";

// One approved tenant/actor's backing storage. InMemoryStorage is not durable.
// For persistence, supply your host-owned storage scoped to that tenant/actor.
const tenantStorage = new InMemoryStorage();
const definition = defineHarness({
  id: "project-agent",
  defaults: {
    workspace: { path: ".", mode: "write" }, // Explicit host-disk write access.
    skillDirs: ["skills"],
    contextFiles: true,
    filesystem: true,                       // Virtual files, not the host disk.
    subagents: true,
    fileMemory: true,
    searchPastSessions: true,
  },
  limits: { toolRoundtrips: 10, maxChildDepth: 2 },
});
const runtime = new HarnessRuntime({
  definition,
  projectRoot: "/srv/approved-project",
  driver: agentDriver({
    name: "project-agent", model,
    // Standing notes and virtual files reuse this explicit backing store.
    // Automatic Agent session storage/extraction is disabled during controlled runs.
    memory: { storage: tenantStorage, summaries: false },
  }),
  grants: {
    toolIds: [
      "fs_read_file", "fs_list_directory", "fs_file_info", "fs_write_file",
      "list_skills", "get_skill_instructions", "get_skill_reference",
      "agent_fs_write", "agent_fs_read", "agent_fs_list", "agent_fs_search",
      "memory", "task", "search_past_sessions",
    ],
    modelRoles: ["main"],
  },
  budgets: { maxModelCalls: 12, maxToolCalls: 20, maxTokens: 16000 },
  executionPolicy: hostPolicy,
});
await runtime.run("Inspect the project", {
  identity: { tenantId: verifiedTenant, userId: verifiedActor },
  sessionId: "project-session",
});
// Close tenantStorage only when its host scope has finished using it.
```

Here `model`, `hostPolicy` and verified identity are application dependencies. The definition reproduces the former feature choices, not implicit permissions: remove `fs_write_file` from grants or use `mode: "read"` when writes are unnecessary. Core rejects string workspaces. Host-file confinement checks static path escapes; use OS isolation against hostile concurrent filesystem mutation.

Without explicitly shared storage, the configured Agent's virtual filesystem and file memory are fresh per run. With the scoped storage above, standing notes and virtual files survive subsequent run-owned Agent instances. `search_past_sessions` searches sessions in that Agent's configured backing storage; it does not search the harness session store. Harness canonical history remains independent. The default harness store and `InMemoryStorage` are process-local and non-durable.

Children receive the same controlled execution boundary, policy, identity and cancellation with fresh child conversation/state. They do not rebind the definition or implicitly acquire all parent Agent defaults. Delegation remains subject to the shared aggregate budgets. [deep-migration.test.ts](src/__tests__/deep-migration.test.ts) exercises the explicit choices with real Agent execution and a fake provider, including rooted skills/project context, write denial, delegation budgets, note persistence and success/failure cleanup.

## Define custom abilities

```ts
import { agentDriver, defineAbility, defineHarness, HarnessRuntime } from "@agentium/harness";

interface NotesService { read(query: string, userId?: string): Promise<string> }
const notes = defineAbility({
  type: "example/notes",
  validate: (options: { service: NotesService }) => ({ service: options.service }),
  describe: () => ({ toolNames: [], requirements: ["notes:read"], runtimeDependent: true }),
  bind: async ({ service }) => ({
    tools: [],
    contextSources: [{
      id: "notes",
      fetch: async (query, run, budget) => {
        run.signal?.throwIfAborted();
        const text = await service.read(query, run.userId);
        return [{ id: "result", text, trust: "source", byteLength: Buffer.byteLength(text) }];
      },
    }],
    middleware: [{
      id: "notes-observer",
      afterModel: async (_response, run) => { run.signal?.throwIfAborted(); },
    }],
    // Dispose resources created by this binding only; service is host-owned.
  }),
});
const runtime = new HarnessRuntime({
  definition: defineHarness({ id: "support", abilities: [notes({ service: notesService })] }),
  driver: agentDriver({ name: "support", model }),
  requirements: ["notes:read"],
  grants: { toolIds: [], modelRoles: ["main"] },
});
```

Options remain statically typed, including callbacks and services. `validate` must be pure. Plain objects/arrays are snapshotted as immutable configuration; fresh containers are supplied to bind/describe. Functions and class instances remain caller-owned references. Represent identity-sensitive SDK clients as class instances. Trusted factories are not sandboxed.

Bindings initialize sequentially once per runtime run and dispose once in reverse order, including partial initialization failure. Reusing a definition creates separate run bindings; child execution within that run shares the supplied services. Do not close caller-owned clients in `dispose`.

Source fetches receive entry/byte/token/deadline bounds and a cancellation signal; runtime retrieval applies central limits across sources. Source estimates are not authority, and retrieval data cannot become host instructions. Middleware IDs must be unique; stable `before`/`after` ordering rejects unknown references and cycles. Model transforms preserve host instructions and provider/tool continuation groups. Observers receive isolated structured-cloneable responses/results. Middleware cannot replace mandatory tool enforcement.

## Compose, inspect and replace

```ts
import { defineHarness, extendHarness, describeHarness, textContext } from "@agentium/harness";

const original = defineHarness({
  id: "product",
  abilities: [textContext({ id: "notes", entries: [] }, { instanceId: "notes" })],
});
const extended = extendHarness(original, {
  id: "product-specialized", disable: ["notes"],
  abilities: [customAbility({ service })],
});
console.log(describeHarness(extended));
```

Inspection reports declarations and diagnostics without binding, discovering credentials or serializing executable options. Use explicit ability instance IDs for reusable definitions.

- Omitted defaults inherit; `false` disables. Skill-directory defaults union stably; `false` clears them.
- `disable` removes an entire ability's tools, context and middleware. `replaceAbilities` explicitly replaces an existing instance ID.
- Duplicate tool/context/middleware/prompt IDs fail. Replace the ability or host tool collection before execution; Agent has no composition replacement option.
- Requirements are explicit runtime host grants, not dependency installation. Runtime grants/policy/identity cannot be widened by definitions or model output.

## Text and file context

`textContext({ id, entries }, { instanceId })` snapshots UTF-8 source entries and has an approved portable factory. `fileContext({ id, root, files }, { instanceId })` reads only fixed host-selected paths beneath an explicit absolute root. Reads occur during fetch; canonical path, UTF-8 and size checks apply. It grants no workspace-wide tools.

```ts
const runtime = new HarnessRuntime({
  definition: research({ files: { id: "project-files", root: "/srv/project", files: ["README.md"] } }),
  driver: agentDriver({ name: "research", model }),
  projectRoot: "/srv/project",
  requirements: ["filesystem:read"],
  grants: { toolIds: [], modelRoles: ["main"] },
});
```

`research` disables automatic workspace tools, context-file discovery, file memory and subagents. `suppliedTools({ tools, requirements? })` wraps trusted ToolDefs without executing or freezing them. `base({ id?, abilities?, defaults? })` supplies a composition shell.

## Portable manifests

```ts
import { defineHarness, exportManifest, hashManifest, loadManifest, textContext } from "@agentium/harness";

const definition = defineHarness({
  id: "portable-notes",
  abilities: [textContext({ id: "notes", entries: [{ id: "one", text: "Source text" }] }, { instanceId: "notes" })],
});
const manifest = exportManifest(definition);
const hash = hashManifest(manifest);
const loaded = loadManifest(JSON.parse(JSON.stringify(manifest)), [textContext.factory!]);
```

Loading requires an approved factory registry; JSON never contains executable factories. Unknown keys, incompatible versions, missing factories and non-JSON options fail. Export requires explicit harness/portable ability IDs and mappings. Local callbacks, clients, file capabilities and tools stay local unless their author supplies an approved equivalent mapping. Credentials never belong in manifests.

Custom `defineAbility` mappings use `portable: { validateOptions, toOptions, toJSON }` and expose `factory`. Hashes cover canonical validated manifest JSON, not function text, live clients or resolved absolute paths. Export Agent configuration and the harness manifest separately; core Agent serialization contains no harness runtime definitions.

## Verification and limits

```sh
npm run build:core
npm run build:harness
npx vitest run packages/harness/src
AGENTIUM_TEST_PACKAGES=1 npx vitest run packages/harness/src/__tests__/package-consumption.test.ts
```

The opt-in package test installs built local tarballs into an isolated offline consumer and verifies ESM/CJS and public TypeScript usage without optional provider/browser/queue SDKs. Build first so stale output cannot stand in for source verification.

The local runtime does not provide durable recovery, distributed ownership, remote policy interception, skill sandboxing, browser/media transport or a visual editor. Those require their explicit integration or recovery contracts. Host capabilities are trusted code, not a JavaScript security boundary.

## Execution drivers and run handles (H2)

`HarnessRuntime` owns a scoped session lease, aggregate call budgets, mandatory
execution policy, event history, completion checks, and cleanup. A driver controls
progress through `start(request, services)`. The supplied services perform model
calls and dispatch effects through the same approval and execution boundary used
by `Agent`. Driver implementations and host bindings are trusted application code;
this interface does not sandbox JavaScript or intercept arbitrary network calls.

```ts
import { Agent, defineTool } from "@agentium/core";
import { HarnessRuntime, agentDriver } from "@agentium/harness";
import { z } from "zod";

// model is the application's existing ModelProvider.
const lookup = defineTool({
  name: "lookup", description: "Read an approved record",
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }) => records.read(id), // host-owned record service
});
const agent = new Agent({ name: "assistant", model, tools: [lookup] });
const runtime = new HarnessRuntime({
  driver: agentDriver(agent, { stream: true }),
  grants: { toolIds: ["lookup"], modelRoles: ["main"] },
  budgets: { maxModelCalls: 8, maxToolCalls: 6, maxTokens: 8000 },
  executionPolicy: {
    decide: () => ({ action: "allow" }),
    resolveEffect: () => "read",
  },
});
const handle = runtime.start("Read record 42", {
  identity: { tenantId: verifiedTenant, userId: verifiedActor },
  sessionId: "conversation-42",
});
for await (const event of handle.events()) render(event);
const result = await handle.result();
// runtime.run(input, options) returns that same terminal result.
```

A `RunHandle` reports exactly one terminal result: `completed`, `failed`,
`cancelled`, `stopped`, or `awaiting_input`. The terminal event contains that same
result and final cursor. `cancel()` records intent and propagates the signal;
settlement and resource release wait until owned work quiesces. A provider or
custom driver that ignores cancellation can delay settlement. Started external
effects are never rolled back. Closing an event iterator closes only that viewer.
Concurrent iterator reads are ordered. The default event history retains 256
events; reconnect with `events({ after: cursor })`. Older cursors receive
`HarnessEventGapError`. Large terminal outputs become scoped artifact references;
retrieve them with `runtime.getArtifact(identity, sessionId, artifactId)`.

Built-in drivers support queued `follow_up` input. The built-in Agent driver also
supports `steer` at complete tool-roundtrip boundaries. Custom drivers may declare
`steer` and consume it with `services.takeInput()`. For live questions, use
`requestInputTool()` or `await services.requestInput()`, then answer with
`handle.reply(requestId, input)`. `handle.state === "awaiting_input"` is nonterminal;
`result()` stays pending and budgets are preserved. Returning the old terminal
`awaiting_input` status is a legacy hand-back, not live suspension.

See [conversational runs](./CONVERSATIONAL-RUNS.md) for clocks, input events,
public messages, provider capabilities, streaming compatibility and compaction.
Unsupported controls throw `HarnessUnsupportedError`. Interrupt-and-replace,
remote policy coverage, and durable recovery remain unsupported. In-memory
events, artifacts, sessions and pending questions are explicitly non-durable.

Host grants are upper bounds. Controllers select only approved tools/model roles;
omitting required tools or selecting unsupported model options fails closed.
Model output limits are clamped to the remaining token allowance and reservations
prevent concurrent calls from sharing that allowance. Reported usage includes
input and provider reasoning tokens, so a provider's actual accounting may exceed
an output estimate; the runtime blocks subsequent calls when exhausted. Model
call/tool attempt limits are enforced independently. A context policy returns an
immutable request projection and provenance; canonical history stays intact.
Opaque provider continuation cannot migrate between model roles.

```ts
const completionPolicy = {
  id: "require-evidence",
  evaluate: async ({ text, revision }) => text.includes("Evidence:")
    ? { action: "accept", reason: "Evidence included" }
    : { action: "revise", reason: "Missing evidence", instruction: "Include Evidence: and its source." },
};
// Supply completionPolicy and budgets: { maxRevisions: 1 } to HarnessRuntime.
// Revisions cannot execute tool effects unless allowRevisionEffects is explicitly true.
```

## Workflows, teams and custom drivers

`workflowDriver(workflow)` accepts a JSON object input patch and preserves the
Workflow constructor's other initial state. Every function step is dispatched as
`workflow:<stepName>` through normal validation, policy, approval, and budget
checks. A deterministic approval workflow can grant only `workflow:submit`, set
`executionPolicy.decide` to `ask`, and inject its host `ApprovalManager`. Its
pending requests include the verified tenant and actor. A denied step returns a
failed terminal result and does not execute the callback. Controlled function
steps do not automatically retry effects.

`teamDriver(team)` uses the existing Team algorithms. Member Agents receive the
same identity, cancellation, policy, and aggregate model/tool budgets. Remote Team
members fail explicitly because this runtime cannot intercept their effects.
Root history and each delegated Agent's complete tool/provider conversation are
retained separately in the session snapshot's `history` and `conversations`.
Failed/aborted partial transcripts are retained with `replayable: false`.

```ts
import type { ExecutionDriver } from "@agentium/harness";
import { testDriverContract } from "@agentium/harness/testing";

const deterministic: ExecutionDriver = {
  id: "example/deterministic", version: 1,
  capabilities: { controls: [], durable: false, policyCoverage: "local", controlledExecution: true },
  async start(request, services) {
    services.append([{ role: "user", content: request.input }]);
    const result = await services.dispatch({ id: "read-1", name: "lookup", arguments: { id: "42" } });
    const text = result.error ?? String(result.result);
    services.append([{ role: "assistant", content: text }]);
    return { text };
  },
};
await testDriverContract(deterministic, {
  tools: [lookup], grants: { toolIds: ["lookup"], modelRoles: [] },
});
```

The explicit testing subpath has no Vitest dependency and checks terminal/result
agreement, ordered identities, final cursor, and settled-result immutability. It
executes a caller-supplied fixture; applications must additionally test their own
driver's effects, cancellation cooperation, and control boundaries.

## Session ownership and portable runtime references

The default store rejects a second writer to the same tenant/actor/session with
`HarnessSessionConflict`. Its declared guarantees are process-local single-writer
safety, no compare-and-swap, and no durability. Different tenants remain isolated.
Session resources acquired through `services.resource(id, "session", initialize)`
are reused until `runtime.resources.closeSession(identity, sessionId)` after all
leases release. Run resources close once in reverse acquisition order; host-owned
clients are never disposed. Cleanup diagnostics do not replace the primary result.
Applications own retention of session/artifact stores and explicit session cleanup.

Configure a definition on the runtime. Core Agent has no harness composition
option. Runtime bindings apply their tools, prompts,
context sources, and middleware to custom-driver model/effect services as well.
The Agent adapter uses `history` plus `ephemeral: true` semantics, leaving canonical
persistence to the harness store and avoiding duplicate Agent session records.
Outside a harness, `agent.run` and `agent.stream` accept `ephemeral: true` to use
externally owned history without automatic session/memory persistence.

Local `defineHarness({ runtime: { driver, controller, contextPolicy,
completionPolicy } })` accepts trusted direct implementations. Portable manifests
contain only `runtime` registry references `{ id, version }`, plus role-to-host
binding preferences. For export, provide matching `runtimeReferences` and
`runtimeRegistry` mappings. `loadManifest(manifest, abilityFactories,
runtimeRegistry)` resolves only explicitly approved implementations and fails on
missing or ambiguous references. Executable references without an export mapping
fail with their exact `runtime.<field>` path. Credentials and clients remain local.

`Agent`'s `checkpointing` option now records tool-roundtrip transcript/state
snapshots and exposes the configured `checkpointManager`. These snapshots support
inspection; deleting later snapshots does not undo effects or resume a run. Durable
execution requires the separate recovery/operation-ledger contract in Plan 004.

Controlled execution rejects ordinary Agent reflection, model-backed compression/tool-result summarization,
and exception-based handoff before starting work. Use `completionPolicy`,
`contextPolicy`, or Team/custom-driver delegation, respectively, so every model
call and revision remains subject to the runtime's budgets and effect policy.
Pure context trimming remains available. Ordinary Agent configurations retain
their existing behavior. A delegated `RunOpts.executionPolicy` is an additional
mandatory restriction and cannot relax either the Agent policy or runtime grants.

### Budgeted reflection and summaries

Use `reflectionPolicy` and `summaryContextPolicy` for model-backed completion and
context processing in H2. Their auxiliary models are explicit host bindings:

```ts
import { reflectionPolicy, summaryContextPolicy } from "@agentium/harness";

const runtime = new HarnessRuntime({
  driver: agentDriver(agent),
  grants: { toolIds: [], modelRoles: ["main", "critic", "summary"] },
  models: {
    critic: { provider: criticModel, options: ["maxTokens"] },
    summary: { provider: summaryModel, options: ["maxTokens"] },
  },
  budgets: { maxModelCalls: 12, maxTokens: 16000, maxRevisions: 1 },
  completionPolicy: reflectionPolicy({
    modelRole: "critic", criteria: "Support factual claims with supplied evidence.",
    maxTokens: 512,
  }),
  contextPolicy: summaryContextPolicy({
    modelRole: "summary", maxContextTokens: 6000, keepRecentTurns: 2,
    summaryMaxTokens: 1000,
  }),
});
```

The critic must return a strict JSON completion decision. Malformed decisions,
truncated responses and unexpected tool requests fail closed. Revisions share
the runtime's aggregate budgets and cannot introduce effects unless the host
enables `allowRevisionEffects`. The policies themselves never execute tools.

Summaries replace only older complete turns in the model request. Host
instructions and the selected recent whole turns remain intact, including opaque
provider continuation and tool/result groups. Summaries are labelled untrusted
historical data; canonical history remains unchanged. The helper rejects an
indivisible recent turn, oversized source or oversized summary instead of silently
truncating it. `maxInputBytes` defaults to 65536. Token sizing is an estimate;
provider context accounting can differ. Already bounded requests make no summary
call. A new oversized projection may incur another bounded summary call.

Custom drivers can use `services.controlModel(role, messages, options)`. A harness-specific policy can narrow its neutral `ctx.executionServices` to `HarnessExecutionServices` to access that extension.
This requires an explicitly granted and bound role, with allowed option keys.
Calls share model/token budgets, cancellation, event accounting and owned-work
settlement. They carry no tools or provider continuation and do not change the
task's active role/tools. They skip task controllers, context projections and ability
middleware to prevent policy recursion; their authority comes from the explicit
host role grant. Legacy Agent reflection/compression configuration remains guarded
under H2: choose these policy ports explicitly.

Custom drivers can register additional asynchronous delegated work through
`services.runOwned(operation)`; the runtime waits for that work before releasing
its session lease and resources. Built-in Agent tool execution uses this ownership
path. Team broadcast and collaboration wait for every started member, including binding cleanup, to settle when one fails.
The conformance helper also disposes resources created in its fixture session,
including when validation fails, while preserving the primary failure.

### Durable watches

`DurableWatch`, `defineWatch`, and `gmailWatchSource` provide explicitly activated,
authorized watches over the core durable task/action contracts. The host supplies
the persistent store, scheduler, authenticated Gmail client and trigger verifier,
and a scoped notification connector. Bounded reads, cursor/digest commits, quiet
hours, send caps and ambiguous-effect reconciliation are included. See the
[watch guide](src/watch/README.md) for setup, crash-recovery guarantees and the
remaining live Gmail/Pub/Sub delivery gates.

### Approved MCP resources

`mcpResources` adds text documents as bounded context through a host-authenticated MCP client. It accepts clients structurally, including both MCP SDK generations; Agentium does not install a resource SDK automatically.

```ts
import { defineHarness, mcpResources } from '@agentium/harness';

const definition = defineHarness({ abilities: [mcpResources({
  id: 'approved-documents',
  resources: [{ uri: 'docs://policies/shipping', mimeTypes: ['text/markdown'] }],
  authorize: (grant, ctx) => host.canRead(ctx.tenantId, ctx.userId, grant.uri),
  connect: async (ctx) => {
    const client = await host.connectMCP(ctx); // authenticates this principal; respects ctx.signal
    return { client, dispose: () => client.close() };
  },
})] });
```

`host` represents application-owned authentication, authorization and connection code. Grant URIs and MIME types are exact. An optional host `select(query, ctx)` can choose a subset of those grants; no server-wide discovery expands access. Setup defaults to a five-second deadline (`connectTimeoutMs`), and a late connection is disposed. Resource reads obey the shared context entry/byte/deadline budget and run cancellation. Authorization is rechecked before reads and before returning content. SDK resource caching is bypassed; v1 clients ignore that extra option and do not implement the v2 response cache. Every returned URI/MIME is checked. Text is labelled source data, with provenance, never inserted as system instructions. Binary documents require an explicit host decoder. Include only decoded text from an approved format/URI; this ability does not execute or fetch resource URIs itself.

### Custom driver and controller telemetry

```ts
import { EventBus } from '@agentium/core';
import { HarnessRuntime } from '@agentium/harness';
import { instrumentBus } from '@agentium/observability';

const telemetry = new EventBus();
const observation = instrumentBus(telemetry, { exporters: ['console'] });
const runtime = new HarnessRuntime({ ...runtimeConfig, telemetry });
await runtime.run('task', { identity, sessionId });
await observation.shutdown();
```

The runtime emits one run lifecycle, uniquely identified model invocations for `services.model`, `streamModel` and `controlModel`, and controller spans for `prepareRun`, `prepareStep` and completion evaluation. Decisions include action, selected model role and active tool count. Success, failure and cancellation close their spans. Observation failures do not control execution. Prompts, output text, controller explanations and tool arguments are omitted from these events.

Use this bus with its own collector when observing the harness. Do not attach the same tracer or metrics collector to both the harness bus and the wrapped Agent bus: those layers share execution IDs and describe overlapping work. Direct provider calls that bypass the execution services also bypass runtime budgets and telemetry; custom drivers should use the services. Transport/toolkit-specific tracing remains available on their existing buses.
