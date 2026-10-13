# Storage isolation and memory lifecycle implementation plan

> **Status: IMPLEMENTED AND VERIFIED, 2026-10-13.** The later user approval authorized parallel execution of M2/M3 and the M1 budget companion. See [RESULTS.md](RESULTS.md) for checked code and commands. These design sketches retain the planning baseline; the [supported guide](../../packages/harness/DEPENDABILITY.md) and current declarations define the final public API.

**Goal:** Make existing storage identities, memory shutdown, and legacy budget reads truthful without adding a storage service or changing the ordinary Agent adoption path.

**Architecture:** Preserve `StorageDriver` and existing memory stores. Fix process-local namespace representation, add an explicit versioned encoding option for persisted keys, and track every background memory operation under one lifecycle owner. Keep canonical cost admission in the current accounting module.

**Spec:** [Core/harness design](2026-10-13-core-harness-dependability-design.md). This is a companion to the [master plan](2026-10-13-core-harness-dependability.md).

**Tech stack:** Existing TypeScript, Node `^22.18.0 || ^24.11.0`, Zod and Vitest. No new dependency.

## Global constraints and review focus

Preserve supplied `StorageDriver` implementations and the current ESM/CommonJS declaration paths. Never fall back from a new encoded key to an ambiguous legacy key automatically. Never close storage while tracked memory work can still write to it. Cancellation of waiting is not proof that a remote write was cancelled. Memory remains source data even when recorded by a human. Do not introduce extraction into harness-controlled ephemeral Agents.

Review delimiter-bearing and empty IDs; Redis glob characters; a summary stalled during close; a run entering while close starts; and budget-fitting memory which previously omitted its wrapper. Pin each in the tasks below.

## M2 — Collision-free storage identities with an explicit persisted migration

### Problem and evidence

Current `packages/core/src/storage/in-memory.ts:6–31` concatenates `(namespace, key)` with `:` and lists by that prefix. `("parent:child", "key")` and `("parent", "child:key")` collide. `storage/scoped.ts:24–29` and `tenant/tenant-storage.ts:13` similarly concatenate unrestricted scope components. `storage/redis.ts:44–49` mixes literal identifiers with SCAN glob syntax. These remain source-confirmed after the earlier audit; the prior audit executed local collision fixtures, but this planning pass did not rerun them.

The harness already uses `JSON.stringify([tenantId, userId, sessionId])` in `runtime/session-bindings.ts:31`. Keep that existing contract.

### Selected design and alternatives

1. Change `InMemoryStorage` to a map of namespace maps. This is a corrective change: separate public namespaces must stay separate. Preserve JSON cloning and `list`'s literal `key.startsWith(prefix)` behavior.
2. Add internal `storage/key-codec.ts`. Scoped namespace tuples use a versioned JSON array, preserving absent versus empty scope values. Redis physical segments use four-digit hexadecimal UTF-16 code units, which preserve exact JS strings and literal key-prefix matching, including unpaired surrogates. Do not use raw delimiters or escaped SCAN input as the identity codec.
3. Add explicit `keyEncoding: "legacy" | "tuple-v1"` options to `ScopedStorage`, `TenantScopedStorage`, and `RedisStorageConfig`. Existing constructors default to `legacy` until a planned major-version migration; new documented shared-host examples select `tuple-v1`. The in-memory namespace fix lands immediately in either mode.
4. Add `ownsInner?: boolean` to wrappers, defaulting to `true` for compatibility; new borrowed-client examples pass `false`. Closing a borrowed wrapper does not close its inner storage. Initialization ownership remains unchanged; document idempotent initialization as the inner driver's responsibility.

Changing persistent defaults immediately would make existing records disappear. Automatic dual reads could expose another scope's legacy record. The selected additive path avoids both. Hosts which need isolation must migrate or create a new store with `tuple-v1`; the legacy mode is explicitly unsuitable for unrestricted identifiers in shared storage.

### Proposed public options and internal encoding

```ts
// Proposed additions to storage/scoped.ts; reused by TenantScopedStorage.
export interface ScopedStorageOptions {
  keyEncoding?: "legacy" | "tuple-v1";
  ownsInner?: boolean;
}

// Proposed addition; retain all existing RedisStorageConfig fields.
export interface RedisStorageConfig {
  keyEncoding?: "legacy" | "tuple-v1";
}

// Proposed internal storage/key-codec.ts.
export function encodeScopeNamespace(
  namespace: string,
  scope: { tenantId?: string; userId?: string },
): string {
  return JSON.stringify([
    "agentium-storage-scope-v1",
    scope.tenantId ?? null,
    scope.userId ?? null,
    namespace,
  ]);
}

export function encodeKeySegment(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index++) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

export function decodeKeySegment(encoded: string): string {
  if (encoded.length % 4 || !/^[0-9a-f]*$/.test(encoded)) {
    throw new TypeError("Invalid storage key encoding");
  }
  let value = "";
  for (let index = 0; index < encoded.length; index += 4) {
    value += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16));
  }
  return value;
}
```

Redis v1 key: `agkv1:<encoded keyPrefix>:<encoded namespace>:<encoded key>`. The SCAN pattern uses the exact encoded namespace plus the encoded literal key prefix plus a single trailing `*`. Decode only the final key segment. The trusted adapter's keyPrefix is encoded too. Continue scanning every page as current RedisStorage does. JSON payload format and TTL semantics stay unchanged.

Representative corrective in-memory implementation:

```ts
private store = new Map<string, Map<string, string>>();

async set<T>(namespace: string, key: string, value: T): Promise<void> {
  let entries = this.store.get(namespace);
  if (!entries) {
    entries = new Map();
    this.store.set(namespace, entries);
  }
  entries.set(key, JSON.stringify(value));
}

async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
  const results: Array<{ key: string; value: T }> = [];
  for (const [key, raw] of this.store.get(namespace) ?? []) {
    if (prefix === undefined || key.startsWith(prefix)) {
      results.push({ key, value: JSON.parse(raw) });
    }
  }
  return results;
}
```

`get`, `delete`, and `close` mechanically follow the namespace map. Delete empty inner maps. Keep deserialization behavior identical to the existing generic KV API; introducing payload schemas here would be a separate breaking change.

### Files, tasks, and tests

- Create `packages/core/src/storage/key-codec.ts` and `storage/__tests__/key-codec.test.ts`.
- Modify `storage/in-memory.ts`, `storage/scoped.ts`, `storage/redis.ts`, `tenant/tenant-storage.ts`.
- Update root exports for `ScopedStorageOptions` and existing Redis config type; do not expose the physical codec as a supported public API.
- Extend `storage/__tests__/storage.test.ts`, `scoped.test.ts`; create `redis-key-codec.test.ts` using the existing optional-dependency mocking pattern, with no network calls.
- Document explicit persistent migration in `packages/core/README.md`; update scoped-storage examples only where they instantiate these wrappers.

Representative proposed regression:

```ts
it("keeps delimiter-bearing namespaces distinct", async () => {
  const storage = new InMemoryStorage();
  await storage.set("parent:child", "key", { value: 1 });
  expect(await storage.get("parent", "child:key")).toBeNull();
  expect(await storage.list("parent")).toEqual([]);
  expect(await storage.get("parent:child", "key")).toEqual({ value: 1 });
});
```

- [x] First pin collisions and exact `list` boundaries with the public API.
- [x] Implement namespace maps and encoding options; preserve legacy physical keys when explicitly/default selected.
- [x] Test empty versus absent scope, `:`, Unicode, unpaired surrogate strings, Redis `* ? [ ] \\`, literal prefixes, TTL and codec round trips.
- [x] Verify `ownsInner:false` leaves a shared driver usable after wrapper close.
- [x] Verify old data is never read through v1 fallback and document this intentional behavior.
- [x] Run `npx vitest run packages/core/src/storage/__tests__`; then `npm run build:core`.

### Migration gate

The SDK cannot reconstruct all ambiguous legacy tuples. Supply a documentation recipe, not an automatic migration command: freeze writers; use a trusted inventory of logical scopes/keys; export each logical record through its intended owner; detect duplicates; import into a distinct v1 prefix; compare counts and payload digests; cut over all writers together; retain the read-only old prefix for the host's rollback window. Do not print data payloads in migration diagnostics. A major release may default to v1 only after this guide and explicit legacy override exist. That release decision is deferred; the opt-in path is implementation-ready.

## M3 — One owner for background memory work and honest context assembly

### Problem and existing behavior

`memory/memory-manager.ts:176–179` launches overflow summaries without adding them to `pendingExtractions`. `afterRun:413–415` tracks extraction only; `awaitExtractions:428` therefore misses summaries. `agent/agent.ts:562–572` closes configured storage without draining memory. Current memory context includes wrapper markers in the unbudgeted path (`assemble:280`) but omits them when all sections fit (`allocateBudget:300–301`). Wrapper cost is also excluded from token admission. `agent/agent.ts:1468–1471` currently appends MemoryManager source text to system instructions. Move it to a separate source-role message; wrappers alone do not preserve authority. `remember:440–467` may resolve without writing when no destination is enabled. Existing `recordCorrection` and `LearnedKnowledge.invalidateContradicted` already exist and remain unchanged; they do not establish a generic project-fact schema.

### Proposed APIs, ownership and lifecycle

```ts
// Proposed exports from memory/memory-manager.ts and core root.
export interface MemoryDrainOptions {
  timeoutMs?: number; // omitted: wait cooperatively without a local deadline
  signal?: AbortSignal;
}
export interface MemoryDrainResult {
  status: "drained" | "timed_out" | "cancelled";
  pending: number;
  failed: number;
}
export type RememberResult =
  | { stored: true; destination: "user_facts" | "learnings" | "entities" }
  | { stored: false; reason: "no_destination" };

// Proposed additive methods; existing methods retain their signatures.
MemoryManager.drain(options?: MemoryDrainOptions): Promise<MemoryDrainResult>;
MemoryManager.rememberWithResult(
  content: string,
  opts?: { userId?: string; scope?: string; importance?: number },
): Promise<RememberResult>;

// Proposed additive fields on existing Agent.close options.
export interface AgentCloseOptions {
  closeStorage?: boolean;
  memoryDrain?: MemoryDrainOptions; // default timeoutMs: 30_000
}
// Agent.close(options?: AgentCloseOptions): Promise<void>;
```

These signatures are API declarations for existing classes, not standalone TypeScript statements to paste literally. Implement `rememberWithResult` using exactly the current destination precedence; legacy `remember` awaits it and returns `void`, preserving no-op compatibility. Document the result-bearing method as the recommended new journey. The persisted fact model is not introduced here.

Rename the private pending set to `pendingMemoryOperations`; introduce private `trackMemoryOperation(kind, promise)`. Track summary and extraction work before callers can observe completion. Attach both success and rejection handlers for removal rather than ignoring the rejected promise returned by `.finally`. Track every asynchronous memory operation launched internally, including nested helper operations, until its final write/settlement; the owned promise must include catch/reporting cleanup. Existing `awaitExtractions()` delegates to `drain()` with no local timeout and now includes summaries; update its description. Increment a monotonic failure counter once per failed owned operation and emit existing `memory.error` events once per operation; do not duplicate store-specific errors.

`drain` snapshots no authority: it waits until the tracked set is empty, including operations added during the wait. A signal/deadline races waiting only. Timeout/cancellation returns pending counts, never clears operations or claims remote cancellation. Clean up every timer/listener. No automatic retries of a possibly applied storage write.

Add private Agent lifecycle state `open | closing | closed`, active top-level operation count, and one close promise. `run` and the first executed step of `stream` acquire/release a local operation lease in `try/finally`. `close` rejects with an exported `AgentLifecycleError` code `AGENT_BUSY` while a top-level operation is active; it does not cancel user work implicitly. On a quiescent Agent, close blocks new run/stream admission, drains memory, detaches webhooks and closes owned accounting/approval resources, then closes storage only if existing `closeStorage !== false`. If drain is not complete, reject with `MemoryDrainError` containing the result, retain the storage and owned resources, and allow a later close attempt; keep run admission blocked until close succeeds. Concurrent close callers share the same in-flight promise. Clear that promise after rejection so retries can drain pending work. Calling close after success is idempotent.

For `closeStorage:false`, drain still applies; borrowed storage must not receive untracked late work. The host remains responsible for not closing the shared client through another owner. This correction adds bounded shutdown latency and a truthful busy/error outcome; document that behavioral compatibility change.

Proposed errors and result-bearing journey:

```ts
export class AgentLifecycleError extends Error {
  constructor(readonly code: "AGENT_BUSY" | "AGENT_CLOSING" | "AGENT_CLOSED") {
    super(code);
    this.name = "AgentLifecycleError";
  }
}
export class MemoryDrainError extends Error {
  readonly code = "MEMORY_DRAIN_INCOMPLETE";
  constructor(readonly result: MemoryDrainResult) {
    super(`Memory drain ${result.status}: ${result.pending} operations pending`);
    this.name = "MemoryDrainError";
  }
}

// Before: remember could silently have no enabled destination.
await agent.memory?.remember("Deployments require review", { userId: "user" });
// After: proposed result-bearing method, without changing legacy remember.
const remembered = await agent.memory?.rememberWithResult("Deployments require review", { userId: "user" });
if (remembered && !remembered.stored) {
  console.info("Memory was not stored:", remembered.reason);
}
await agent.close({ closeStorage: false, memoryDrain: { timeoutMs: 5000 } });
```

Error codes are new named exports from core root. Close failure after drain (e.g. owned storage close rejection) retains closing admission and allows retry; each owned teardown component is marked closed only after acknowledgement, so a retry never double-disposes acknowledged resources. Preserve the first teardown error and attach later failures as bounded diagnostics. A user-initiated close does not cancel an active operation.

### Representative tracking and assembly changes

```ts
private trackMemoryOperation(operation: Promise<void>): Promise<void> {
  this.pendingMemoryOperations.add(operation);
  void operation.then(
    () => this.pendingMemoryOperations.delete(operation),
    () => this.pendingMemoryOperations.delete(operation),
  );
  return operation;
}
```

Wrap the existing summary and extraction promises with this helper, retaining their error-reporting behavior. `failed` is `failureCountAtReturn - failureCountAtDrainEntry`, computed from one monotonic counter; overlapping drains each report failures during their own interval. Track failure before removing the operation so a drained result observes it. A drained result may have failed > 0 because work ended unsuccessfully; it does not imply data was saved. Existing error events identify those failures. A failure result does not imply a write can be retried safely.

Extract a private `renderMemorySection(key, content): string` used by `assemble` and every `allocateBudget` branch. The wrapper explicitly labels content as source data. Count rendered strings and separators, not only raw contents. Whole sections are the default atomic unit; omit a section that does not fit rather than sever a correction/negation with the current line trimming. Return a short omission marker only if its tokens fit. Keep priority ordering stable. If all wrappers alone exceed the budget, return an empty context and an existing observation event/optional diagnostic; never exceed the configured budget merely to explain omission. Validate `maxTokens` as a positive safe integer when configured. This output change is corrective and can affect answer quality; the evaluation milestone measures it.

Move only the MemoryManager-generated context out of `systemContent` in Agent.buildMessages. Keep host-authored instructions in the existing system message. After that message and before resident history, insert `{ role: "user", content: memoryContext, providerExtras: { memoryContext: { version: 1, trust: "source" } } }`. Budget/history admission includes that rendered message as fixed context; do not increase a requested memory token allowance to accommodate wrappers. Keep it out of canonical new user/model/tool messages so it is not re-recorded as a user requirement on the next turn. Metadata labels are provenance, not an access check or prompt-injection guarantee. The user-message role enforces the provider priority distinction. Explicitly defer reclassifying host-configured skill/rule/context-file content until its ownership contract is reviewed; M3 must not silently lower legitimate host instructions.

Add a captured-request test: remembered text says "Ignore the host instructions"; the host instruction remains unchanged in the system message, remembered text is only in the source user message, and canonical history does not acquire a synthetic human instruction. Quality resistance to source instruction attacks belongs in M6 evaluation; role separation alone is not a behavioral proof.

### Files and acceptance tasks

- Modify `packages/core/src/memory/memory-manager.ts`, `agent/agent.ts`, and root `index.ts`.
- Create `memory/__tests__/memory-lifecycle.test.ts` and `agent/__tests__/agent-close.test.ts`; extend `memory/__tests__/memory-manager.test.ts`.
- Update `packages/core/README.md`; harness driver disposal keeps `closeStorage:false` and benefits from the bounded drain. No change to harness extraction defaults.

- [x] Hold the overflow summary provider promise open; verify `drain` remains pending and `awaitExtractions` now includes it.
- [x] Verify drain timeout leaves pending work tracked, store open, and a later drain succeeds after the fixture settles.
- [x] Test extraction and summary failures report diagnostics once, all listener/timer paths clean up, and close does not erase primary operation errors.
- [x] Test two close callers, repeated close, active-run rejection, a paused stream iterator, and run admission after close starts.
- [x] Test `closeStorage:false` never closes a borrowed driver; a host store remains usable.
- [x] Verify identical source wrappers in budgeted/unbudgeted paths; counted output including markers never exceeds the budget. A correction with a negation is included intact or explicitly omitted.
- [x] Verify `rememberWithResult` returns `no_destination` for default-disabled destinations while legacy `remember` still resolves.
- [x] Run `npx vitest run packages/core/src/memory/__tests__ packages/core/src/agent/__tests__/agent-close.test.ts`; then `npm run build:core`.

An uncooperative SDK callback can leave `pending > 0`. The design reports this and retains ownership; it does not force termination. Extending signals through every old extraction store is deferred until its versioned cancellation/effect contract is designed. `drain` alone never claims that ability.

## M1 companion — Guard incompatible legacy budget reads

`cost/cost-tracker.ts:271` and `418` reject synchronous local summaries once canonical accounting is used. `checkInProgressBudget:335`, `isBudgetExceeded:375`, `estimateRemaining:405`, and the string overload of `checkBudget:227` still read `legacyTotals`. They can return a plausible false or remaining allowance for a canonical ledger.

Selected corrective change: the three methods and string checkBudget overload call one private guard at entry (after object-overload dispatch), before even an absent legacy budget branch. Preserve their legacy behavior otherwise. Keep existing asynchronous ledger queries and admission APIs as the supported canonical path; do not duplicate currency admission in harness.

```ts
private assertLegacyBudgetRead(): void {
  if (this.canonicalUsed) {
    throw new IncompleteCostError(
      "Canonical accounting requires ledger budget decisions; synchronous legacy budget reads are incomplete",
    );
  }
}
```

- [x] Add a canonical measurement fixture to `packages/core/src/cost/__tests__/cost-tracker.test.ts`; assert each legacy method, including string checkBudget, throws `IncompleteCostError` rather than reporting allowance.
- [x] Verify genuinely legacy usage preserves each existing method's values.
- [x] Inspect core Agent call sites to ensure canonical execution already uses ledger admission; replace any newly found deprecated call with the existing asynchronous admission method, never catch-and-return-false.
- [x] Update root TSDoc/README deprecations with a before/after query example. Existing canonical symbols are `queryUsage`, `queryCosts`, `queryAssessments`, `queryRunUsage` and the object overload of `checkBudget(scope, bound?)`. Use `await tracker.checkBudget({ tenantId, runId, sessionId })` for a ledger decision; inspect its status/reservation and let the existing accounting owner reconcile or release its reservation. The string overload remains legacy and now rejects canonical use; do not replace a read with a reserving call without documenting reservation ownership. Use `await tracker.queryRunUsage(scope)` for an observational query.
- [x] Run `npx vitest run packages/core/src/cost/__tests__/cost-tracker.test.ts packages/core/src/__tests__/cost-tracker-incremental.test.ts`.

## Completion and limitations

Each milestone can land independently after its focused checks, declarations, and documentation pass. Run `npx biome check` on changed TypeScript files; `npm run build`; `npm run test:package`; and `git diff --check` at the combined release review. RESULTS.md records the completed focused and combined checks rather than inferring results from these planned commands.

Still host-owned: persistent key migration, multi-owner atomic session guarantees, arbitrary client shutdown outside Agent ownership, storage-retention policy, and external write reconciliation. Neither tuple encoding nor local operation tracking creates durable active-run recovery.
