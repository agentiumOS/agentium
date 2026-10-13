# Storage identities and migration

`InMemoryStorage` keeps separate maps for namespace and key. Colons, empty strings and Unicode cannot make two namespace/key pairs share a record. It remains process-local storage.

Persistent scope wrappers and Redis keep their existing `legacy` encoding by default so upgrades do not hide existing records. For new shared stores with unrestricted tenant, user, namespace or key strings, explicitly select `tuple-v1`:

```ts
import { RedisStorage, ScopedStorage } from "@agentium/core";

// The host supplies the connection and verified identity. ioredis is optional.
const backing = new RedisStorage({
  url: process.env.REDIS_URL,
  keyPrefix: "application-v1",
  keyEncoding: "tuple-v1",
});
const scoped = new ScopedStorage(
  backing,
  { tenantId: "verified-tenant", userId: "verified-actor" },
  { keyEncoding: "tuple-v1", ownsInner: false },
);
await scoped.initialize();
await scoped.set("sessions", "conversation:1", { messages: [] });
await scoped.close(); // Borrowed wrapper: backing remains open.
await backing.close(); // Host closes its client after all scopes finish.
```

`TenantScopedStorage(inner, tenantId, options)` accepts the same options. `ownsInner` defaults to `true` for existing callers. Initialization is still forwarded; the inner driver must make initialization idempotent.

The scope codec stores a JSON tuple containing its version marker, tenant, user and logical namespace. Missing IDs become `null`, which distinguishes them from empty strings. Redis v1 keys start with `agkv1:` and encode the prefix, namespace and key as fixed-width UTF-16 hexadecimal segments. This preserves exact JavaScript strings and literal key prefixes, including Redis glob characters. Redis `list(namespace, prefix)` returns decoded logical keys.

The two settings protect different layers. A tuple scope wrapper on legacy Redis does not remove Redis's own namespace/key ambiguity. Legacy scope encoding on v1 Redis does not remove collisions that the wrapper already created. Configure both when both are used.

Changing `keyEncoding` creates a different physical key space. V1 never falls back to legacy records. There is no automatic migration or cross-format scan. Use a host migration with these steps:

1. Stop writers and back up records, TTLs and the original key configuration.
2. Recover each logical tenant, user, namespace and key from authoritative metadata. A legacy collision may have overwritten data; the encoded key alone cannot recover that history.
3. Write records through explicitly configured v1 drivers into a separate target prefix. Preserve TTL/retention policy with the host's adapter.
4. Compare counts and values by logical identity, including empty IDs, colons, Unicode and literal glob prefixes. Switch all readers and writers together.
5. Keep the backup and old configuration for rollback. Avoid concurrent old/new writers unless the host implements and verifies a reconciliation protocol.

These codecs define identity, not authentication, encryption, retention or distributed locking. The host must derive scope from authenticated users and coordinate shared writers. The local codec and fake Redis tests establish collision and prefix behavior; they do not certify a live Redis deployment.
