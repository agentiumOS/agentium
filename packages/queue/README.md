# @agentium/queue

Background Agent, Team and Workflow execution on BullMQ **5.81.5+ within v5 or 6.3.11+ within v6** and Redis. Node 22.18+ or 24.11+ is required. New queues can use v6; migrate persisted legacy repeat records with v5 before deploying v6 workers or writers.

```sh
npm install @agentium/queue bullmq@^6.3.11 ioredis
```

```ts
import { AgentQueue, AgentWorker } from "@agentium/queue";

const connection = "redis://127.0.0.1:6379/0";
const queue = new AgentQueue({ connection, defaultJobOptions: {
  attempts: 3, backoff: { type: "exponential", delay: 1000 },
} });
const worker = new AgentWorker({ connection, agentRegistry: { assistant: agent } });
await queue.enqueueAgentRun({ agentName: "assistant", input: "Summarize the report" });
await queue.schedule({ id: "daily-summary", cron: "0 9 * * *", timezone: "UTC",
  agent: { name: "assistant", input: "Summarize new reports" },
});
// The same ID updates its schedule; it does not create another scheduler.
await queue.unschedule("daily-summary");
await worker.stop();
await queue.close();
```

The default queue name is now `agentium-jobs`; the old `agentium:jobs` was rejected by current BullMQ because queue names cannot contain colons. Set the same explicit, valid `queueName` on producer and worker to continue an existing deployment. Constructors load BullMQ through Node's ESM-compatible `createRequire`. Redis URLs preserve credentials, database and `rediss:` TLS settings.

`schedule` accepts exactly one `agent`, `team` or `workflow` target, and uses a stable caller-supplied Job Scheduler ID. Workflow payloads forward `initialState`, `sessionId`, `userId` and `tenantId` into `Workflow.run`. Agents and Teams also forward identity. Queue access is a trusted host boundary: authenticate producers and authorize these claims before enqueueing; a Redis payload is not proof of identity.

Retry configuration belongs to the producer's `defaultJobOptions` or individual enqueue options. The previous `WorkerConfig.attempts/backoffDelay` fields never controlled BullMQ jobs; they have been removed from the TypeScript API. JavaScript callers still receive a migration diagnostic before BullMQ or a connection is initialized. Retrying effectful agent work requires application idempotency. `cancelJob` removes a waiting/delayed job and cannot cancel an active locked job. `stop` drains active work and reports its timeout; it does not claim that remote effects were rolled back.

## Persisted repeat schedule migration

BullMQ v6 removes legacy repeat APIs. `listLegacySchedules()` and `removeLegacySchedule()` require a BullMQ v5 installation and fail clearly on v6, including on clean queues. On v6, `schedule`, recurring enqueue and `listSchedules` refuse a queue containing legacy metadata; they do not migrate it or silently hide it. See the [official v5-to-v6 migration guide](https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6).

Perform the following maintenance with BullMQ 5.81.5 (or a compatible v5 release). Legacy records stay in Redis until an operator removes them. Do not run old and new schedule writers concurrently.

1. Stop schedule writers, call `queue.pause()`, let active jobs finish, then stop workers. `removeLegacySchedule` requires both a paused queue and zero active jobs.
2. Save `await queue.listLegacySchedules()` and the original application payloads/options. The inventory includes keys, names, cron, timezone and next timestamp; it is not a complete payload backup. Back up Redis before changes.
3. Choose stable new IDs and deduplicate the desired schedule set. Remove each legacy key with `removeLegacySchedule(key)` before calling `schedule`. New creation refuses a matching legacy name/cron to prevent accidental overlap.
4. Verify `listLegacySchedules()` is empty for the whole queue and `listSchedules()` contains exactly the intended IDs. Close the v5 maintenance client. Deploy v6 workers and writers, verify `listSchedules()` again, then `await queue.resume()` and enable schedule writers.
5. To roll back, stop v6 workers/writers and return to v5 while paused and drained. Remove replacement IDs using `unschedule`, restore the old records with saved original BullMQ repeat options and payloads (or restore the Redis backup), verify the inventory, and restart the old deployment. Never restore legacy records while replacements are active.

The convenience `enqueue*({repeat})` APIs now upsert schedulers using a hash of target, payload and repeat options. Changing the payload changes that hash; use `schedule({id})` when you need stable updates. `listSchedules` excludes legacy records on v5 and rejects them on v6. BullMQ stores both formats in the repeat index: the adapter recognizes new schedulers by their returned `iterationCount` and also handles the v6 SDK diagnostic for older legacy keys. The migration check is not a lock against concurrent legacy writers; stopping them remains required.

## Verification

Run this command from the repository root after building core:

```sh
AGENTIUM_REDIS_TEST=1 AGENTIUM_REDIS_PORT=6389 npx vitest run packages/queue/src/__tests__
```

Use a disposable Redis database. Fixtures create unique queues and remove only those queues. CI runs them against an isolated Redis 7 service. They exercise the real BullMQ 5.81.5 and 6.3.11 SDKs: scheduler upserts/removal, v5 persisted legacy data rejected by v6, explicit paused v5 migration, v6 use of migrated scheduler records, older legacy-key rejection, worker identity/progress isolation and durable delivery. The fixture uses the `bullmq-v5` development alias for the v5 maintenance process; it does not emulate SDK methods. Redis Cluster and alternative BullMQ backends are outside this fixture.

## Opt-in durable delivery

`DurableAgentQueue` and `DurableAgentWorker` use a separate `agentium-durable` queue. The task store owns execution state; Redis delivers a versioned hint containing only tenant/task IDs and an immutable definition digest. Existing Agent/Team/Workflow workers keep their current behavior.

```ts
import { DurableAgentQueue, DurableAgentWorker } from '@agentium/queue';
// supervisor uses the same initialized durable store on all workers.
const durable = new DurableAgentQueue({ connection, supervisor, admit: admitTask });
const durableWorker = new DurableAgentWorker({
  connection, supervisor, admit: recheckCurrentGrants,
  drivers: [{ id: 'save-document', version: 1, recoverable: true, execute: saveDocument }],
});
await durable.enqueue({
  id: taskId, identity: verifiedIdentity, manifestHash, inputRef,
  policyRevision: 1, grantRefs: approvedGrants,
  driver: { id: 'save-document', version: 1 }, input: { documentRef },
});
```

Both callbacks are mandatory trusted-host admission boundaries. Producer admission happens before persistence; worker admission happens before and after the atomic claim. Versioned drivers must explicitly support replay with stable action IDs and reconciliation. Registering an ordinary Agent/Team/Workflow function does not establish that property.

Persistence precedes Redis enqueue. If enqueue fails, the task remains recoverable: retry the same immutable definition or call `wake({tenantId, taskId})`. Wake explicitly after approval or reconciliation. Duplicate delivery is fenced by the store; an early retry remains delayed until an existing lease can be reclaimed. Completed task deliveries return only task/state/revision metadata to Redis. Unknown external outcomes block handler execution until reconciliation.

`cancel` persists cancellation and wakes a worker; it does not claim immediate remote termination. The host must retry `wake` when Redis is unavailable. `stop` drains active work. Maintain a host recovery sweep for persisted work without a delivery hint; this package does not scan arbitrary stores or start hidden background services. See the [durable store and recovery contract](../core/src/durable/README.md).
