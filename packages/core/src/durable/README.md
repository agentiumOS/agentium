# Durable task foundation

`DurableTaskSupervisor` adds persisted task ownership to replay-aware host handlers. Ordinary `Agent.run`, `AgentWorker`, local approvals, and conversation checkpoints remain local APIs; registering one does not make its effects durable.

```ts
import {
  MongoDBDurableTaskStore, DurableTaskSupervisor,
  MongoDBDurableDocumentConnector, DurableActionLedger,
} from '@agentium/core';

const store = new MongoDBDurableTaskStore(process.env.DURABLE_MONGO_URI!, {
  database: 'agentium', collection: 'durable_tasks',
});
await store.initialize();
const supervisor = new DurableTaskSupervisor(store);
// Identity, grants, references and input are validated by host admission first.
await supervisor.create({
  id: 'task-1',
  identity: { tenantId: 'tenant-1', actorId: 'actor-1', sessionId: 'session-1', runId: 'run-1', rootRunId: 'run-1' },
  manifestHash: 'sha256:approved-manifest', inputRef: 'input:retained-digest',
  policyRevision: 1, grantRefs: ['grant:document-write'],
  budget: { maxAttempts: 8, maxTokens: 10000, maxCostMicros: 1000000 },
});
const key = { tenantId: 'tenant-1', taskId: 'task-1' };
// `collection` is a host-owned MongoDB collection configured for primary reads
// and majority+journal acknowledgement. No SDK or credentials enter records.
const connector = new MongoDBDurableDocumentConnector(collection, 'approved-inbox');
await supervisor.run(key, 'worker-1', async ({ actions, reserve }) => {
  await reserve(100, 1000); // Before host model work; not automatic billing enforcement.
  return actions.execute({
    id: 'save-result', connectorVersion: connector.version,
    destination: 'approved-inbox', args: { result: 'fixture result' },
  }, connector);
});
```

## Atomicity and ownership

Each task is one bounded aggregate containing immutable definition fields, state, monotonically increasing fence, lease, attempts, reservations, action/approval audit, and extension records. The default aggregate limit is 2 MB. Large inputs, outputs and media must use retained references. `durableTaskDigest` normalizes default budgets and excludes mutable audit/extensions when checking duplicate admission.

MongoDB updates compare the prior revision and lease token atomically. Lease checks use server `localTime` and `$$NOW`, never worker wall clocks. Writes require majority acknowledgement and journaling. This uses [MongoDB single-document atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/); it does not provide cross-task transactions. The task and an extension outbox can commit together, but a separate artifact blob or external effect cannot share that commit. `InMemoryDurableTaskStore` advertises `durable: false` and is only for local tests/development.

`store.update` is a trusted host API: callbacks must be synchronous, side-effect-free and safe to rerun after CAS conflicts. Supply the worker fence for execution mutations. The store enforces immutable identity/manifest/input/driver/policy/grant/budget fields, append-only attempt/action/approval audit and legal task/action transitions. Tenant keys are routing/ownership fields, not authentication; higher adapters must verify the caller before constructing them. Each task budget is independent; a host coordinating a root task and children must reserve any shared budget centrally.

## Recovery, approvals and cancellation

Use deterministic action IDs within a task. Preparation hashes canonical arguments, destination, connector version, identity, policy revision and grants. Reusing an action ID with changed arguments fails. Confirmed actions return their stored result reference without repeating dispatch.

An approval-required action persists its pending decision before suspension. The supervisor releases the lease. A trusted endpoint calls `DurableActionLedger.decide` with the authenticated reviewer, approval ID and prepared hash; changing actor/hash, replaying a decision, or using an expired decision fails. Approval consumption and dispatch intent commit atomically. The same approval cannot authorize another dispatch, including a retry after authoritative evidence of no effect; use a newly admitted action/task and review. Current policy/grant validity must be rechecked by host admission and connector authorization, especially after suspension.

A recovered `executing` action becomes `unknown`. The supervisor refuses to invoke the handler until a fenced reconciliation resolves it. Connector exceptions after dispatch also become unknown. The Mongo document connector provides a real append-only effect with unique idempotency key and a readable receipt; absence remains unknown because an earlier request could still arrive. Generic connectors must implement their own authoritative reconciliation. A transient HTTP 404 does not prove no effect. This is not exactly-once execution and does not make shell commands, emails or payments safe to replay.

`cancel` first persists `cancel_requested`; the executing supervisor polls, aborts its signal and waits for tracked action work to settle. It acknowledges `canceled` only when no executing/unknown action remains. Noncooperative external operations can delay that acknowledgement. Lease loss aborts local work and prevents late state/result commits, but cannot retract an already sent request. Operators can claim a cancellation-pending task, reconcile its actions, then call `acknowledgeCancellation`. Terminal task states cannot be revived; create a new task for a new operator action.

## Verification and operational limits

Ordinary tests cover fencing, immutable identity, reservations, stale arguments, approval reuse, cancellation and unknown outcomes. Opt-in Mongo tests use a dedicated database and two actual child processes, including SIGKILL before dispatch, after the Mongo effect before confirmation, and during approval suspension:

```sh
AGENTIUM_DURABLE_MONGO_TEST=1 \
AGENTIUM_DURABLE_MONGO_URI='mongodb://127.0.0.1:27319/?directConnection=true' \
npx vitest run packages/core/src/durable/__tests__/mongodb.integration.test.ts
```

The test deletes only its generated `agentium_durable_fixture_*` database. Use a disposable test server. These gates do not establish production replica-set failover, backup recovery, multi-region clock behavior, arbitrary connector idempotency or shared parent-budget accounting. Retention and compaction of bounded audit/event extensions belong to the host adapter; never silently discard unresolved action or approval records.

## Persistent events, snapshots and artifacts

Wrap the task store with `JournaledDurableTaskStore` before constructing the supervisor and `DurableRunRecords`. State transitions then append their lifecycle event in the same task CAS. Explicit events use `records.append(key, lease, type, data)` and share the sequence. Reads require both verified tenant and actor identity; reconnecting before retained history or after the current sequence throws `DurableEventGapError` with the retained bounds. Defaults retain 256 events, each explicit event at most 32 KiB; the overall task aggregate bound still applies.

`MongoDurableBlobStore` optionally stores immutable bounded bytes in a separate collection. `records.putArtifact` returns an internal reference, never a public URL. `checkpoint` stores finite canonical JSON including provider envelopes; `snapshot` verifies ownership, expiry, size and digest before returning it. A snapshot restores data only: it does not rewind external effects or make a driver resumable. The host decides its snapshot schema and validates it against the task's immutable input and manifest before resuming.

Blob persistence precedes the fenced reference commit. Lease loss can leave an unreferenced blob for host garbage collection, but cannot publish a stale reference. Configure expiry, aggregate limits, orphan collection and backups; never garbage-collect unresolved action evidence. `MongoDurableBlobStore.close()` releases its owned client; task-store clients have their own lifecycle. The `agentium.records.v1` extension is reserved for these services: host admission must not accept externally supplied records in that namespace.

The real Mongo integration gate also closes/reopens record/blob clients, verifies terminal event replay, scoped snapshot recovery and immutable blob collision behavior. It supplements deterministic retention-gap, corruption, expiry and stale-lease regressions.
