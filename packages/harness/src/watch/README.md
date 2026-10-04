# Durable watches

`defineWatch` and `describeWatch` are pure JSON operations. `DurableWatch` binds host services but does not start work until `activate()` is called. The optional `gmailWatchSource` takes an already authenticated structural client and an explicit push verifier; it loads no Google SDK, credentials or environment configuration.

```ts
import { defineWatch, DurableWatch, gmailWatchSource } from "@agentium/harness";

const source = gmailWatchSource({
  id: "gmail-v1",
  mailbox: "owner@example.com",
  identity: { tenantId: "tenant-1", actorId: "owner-1" },
  topicName: "projects/my-project/topics/mail-events",
  labelIds: ["INBOX"],
  client: authenticatedGmailClient,
  verifyPush: verifyPubSubPush,
});
const definition = defineWatch({
  id: "important-mail",
  version: 1,
  identity: { tenantId: "tenant-1", actorId: "owner-1" },
  sourceId: source.id,
  sourceScope: source.scope,
  channel: "email",
  destination: "owner@example.com",
  policyRevision: 1,
  grantRefs: ["read-owner-inbox", "notify-owner"],
  timeZone: "America/New_York",
  quietHours: { start: "22:00", end: "07:00" },
  limits: { maxNotificationsPerDay: 5 },
});
const watch = new DurableWatch(definition, {
  store: durableTaskStore,
  source,
  scheduler: durableHostScheduler,
  notifications: scopedNotificationConnector,
  authorize: authorizeWatchOperation,
  filter: (event) => event.data !== null,
});
await watch.activate(); // Explicit subscription and schedule creation.
```

The client, verifier, durable store, scheduler, notification connector and authorizer in this example are host bindings. `authorize` must validate the authenticated tenant/actor, source grant, fixed notification channel/destination, policy revision and requested amounts. It must also enforce exclusive ownership of the source mailbox and active configuration version: Gmail supports one desired watch per account, so independent versions must not compete to renew it. JSON grant references are references to host authority, not grants by themselves. Deterministic filters are trusted local code; changing their behavior requires a configuration-version change. This first watch implementation makes no model calls.

A scheduler receives idempotent, tenant-scoped `poll`, `renew` and `flush` jobs. Persist each job and route it back to the matching watch/configuration version; execute the corresponding explicit method. Schedule upserts/cancellations must be idempotent. Desired schedule times remain in the task aggregate if publishing a job fails; calling `activate()` again repairs them. Source activation must be an idempotent desired-subscription operation. An activated source's baseline cursor is persisted before subscription creation, so a crash during activation cannot skip ahead on retry.

`trigger(raw)` invokes the source's authenticated verifier, checks its principal and source scope, and reads from the persisted cursor. The claimed push cursor cannot advance state. The host should acknowledge a push only after `trigger()` resolves. Duplicate/out-of-order hints can perform a bounded incremental read, but stable semantic event IDs deduplicate notification admission. A quiet or unchanged wake makes zero model calls and sends nothing.

## Lifecycle and recovery

- `activate()` / `resume()` revalidate grants, establish or renew the subscription, and persist desired schedules. A deleted version cannot resume.
- `pause()` stops new admission and cancels schedules. It retains the source subscription until expiry, along with pending digests, prepared sends and unknown effects. If another operation holds the lease, pause fails as busy; it does not pretend in-flight work has stopped.
- `update(nextDefinition, nextServices?)` requires a newer version with the same identity, watch ID and timezone. It pauses the previous version before activating the replacement. This is a fail-closed rollout, not a transaction across versions. Same-source updates inherit cursor, deduplication IDs, cooldown and daily reservations. Old pending/unknown notifications stay in the original aggregate with their original grants and destination. Deleting a retired version cannot stop the replacement subscription.
- `delete()` writes a tombstone, cancels schedules and stops the owned subscription. It does not erase audit or terminal-cancel an aggregate containing an unresolved external effect. Retry `delete()` if stopping the source failed.
- `inspect()` returns an authorized copy of persisted watch state. `reconcile(outboxId)` remains available after pause, update or deletion and never dispatches a notification.

Cursor advancement, bounded processing decisions and pending digest events commit in one fenced aggregate update. `flush()` atomically groups pending events into one immutable outbox entry, reserves the local-day send cap before any dispatch, and then uses `DurableActionLedger`. A flush sends at most one digest. Destination, connector version, policy revision, grants, identity and arguments are bound into the action and idempotency key. Sending is reauthorized immediately before dispatch. A digest counts as one notification; its event count is also supplied to the authorizer.

A lost acknowledgement is **unknown**, even when the remote provider may have sent successfully. Subsequent flushes cannot replay that effect. The host connector must reconcile it with durable evidence; an `absent` result must prove the original request cannot still take effect. Unknown first-in-line sends deliberately block newer digests until resolved. A successful reconciliation can be repeated safely, including after a crash between action confirmation and outbox acknowledgement. A paused/deleted version never automatically sends pending work. Delivering a paused old version requires explicit resume and host authorization; deletion permanently stops new sends for that version.

Leases fence local commits. They cannot retract requests already sent to a remote endpoint. Watch methods await their owned work before releasing a lease; noncooperative sources/connectors can delay settlement. The host needs connector-level idempotency or reconciliation for real external effects. The library does not claim exactly-once email delivery.

## Bounds, quiet hours and Gmail

Defaults are 4,096 work/lifecycle operations, 1,000 wakes, 100 events per wake, five source pages, 100 resync events, 256 pending events, 4,096 decisions, 128 outbox entries, 8 KiB per event, 512 KiB watch state and 20 notifications per local day. Bounds fail closed before cursor advancement or new effects. Aggregate storage and action-ledger limits apply too. This is a bounded watch version, not an indefinitely growing history store; rotate or archive with explicit host policy before exhausting its budgets. Authorized pause, deletion and reconciliation use fenced maintenance leases independently of the work budget, including after the durable task is stopped or canceled. They preserve terminal state and cannot dispatch new notifications. The durable store is authoritative for time and reservations.

Daily windows are stored as dates in the configured IANA timezone. Reservations are conservative: denied/uncertain sends retain their charge; a prepared notification delayed to a later day also reserves that delivery day. Quiet windows apply to both repeated autumn hours; a skipped spring boundary advances to the first allowed valid instant. The search is bounded to 30 hours and fails closed if no allowed instant is found. Cooldown and send limits survive restart/resync. Changing timezone requires a new watch identity, to avoid silently resetting local-day accounting.

Gmail history IDs stay decimal strings and are compared with `BigInt`. History and full-sync pages/message counts are bounded. An expired-history 404 causes a bounded full sync whose historical events are recorded as suppressed decisions; it never generates historical notifications merely because a cursor expired. Metadata reads request From/To/Subject/Date plus the returned snippet, not complete message bodies. Source content remains untrusted data.

The default renewal interval is one day, shortened if expiry is sooner; polling defaults to five minutes. Gmail requires renewing within seven days and recommends daily renewal, and missed/delayed push notifications need polling fallback. [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push), [synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync), [history.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

## Verification and deployment limits

Deterministic tests cover activation recovery, scopes, cursor/digest atomicity, deduplication, limits, resync suppression, expired subscriptions, uncertain effects, version retirement and DST. The isolated Mongo suite kills real child workers after cursor commit, after reserving a digest before dispatch, and after committing a real Mongo document effect before confirmation. It verifies recovery and reconciliation without another effect:

```sh
AGENTIUM_DURABLE_MONGO_TEST=1 npx vitest run packages/harness/src/watch/__tests__
```

Its default fixture URI is `mongodb://127.0.0.1:27319/?directConnection=true`; `AGENTIUM_DURABLE_MONGO_URI` explicitly overrides it. Each run creates and removes a uniquely named fixture database. `requireDurability: false` permits in-memory test bindings; those bindings do not acquire durable capabilities.

No sandbox Gmail account, Pub/Sub subscription or real notification destination was activated by these tests. Production rollout still requires explicit operator-authorized tests of the host's authenticated Gmail client, push signature/audience verification, exclusive mailbox ownership, durable scheduler, grant revocation and notification provider's idempotency/reconciliation. The fixture effect is an idempotent Mongo document, not evidence that a chosen mail provider offers exactly-once delivery. No model classifier, general scheduler, OAuth token vault or autonomous live activation is included.
