import type { StorageDriver } from "./driver.js";
import { encodeScopeNamespace } from "./key-codec.js";

export interface StorageScope {
  /** Tenant / organization identifier. */
  tenantId?: string;
  /** User identifier within the tenant. */
  userId?: string;
}

export interface ScopedStorageOptions {
  /** Legacy defaults preserve existing records. Select tuple-v1 for unrestricted shared-storage identities. */
  keyEncoding?: "legacy" | "tuple-v1";
  /** Defaults to true. Borrowed wrappers should pass false so close leaves the inner driver open. */
  ownsInner?: boolean;
}

/**
 * Wraps any `StorageDriver` and namespaces every key by tenant / user, providing
 * scope namespaces without requiring per-driver changes. Legacy encoding can
 * collide for unrestricted IDs; tuple-v1 requires an explicit persisted migration.
 *
 * Namespace transformation:
 *   "sessions" + scope { tenantId: "acme", userId: "u1" }
 *   -> "tenant:acme:user:u1:sessions"
 */
export class ScopedStorage implements StorageDriver {
  constructor(
    private readonly inner: StorageDriver,
    private readonly scope: StorageScope,
    private readonly options: ScopedStorageOptions = {},
  ) {}

  private ns(namespace: string): string {
    if (this.options.keyEncoding === "tuple-v1") return encodeScopeNamespace(namespace, this.scope);
    const parts: string[] = [];
    if (this.scope.tenantId) parts.push(`tenant:${this.scope.tenantId}`);
    if (this.scope.userId) parts.push(`user:${this.scope.userId}`);
    parts.push(namespace);
    return parts.join(":");
  }

  initialize(): Promise<void> {
    // Initialization is forwarded even when borrowed; the inner driver owns idempotency.
    return this.inner.initialize?.() ?? Promise.resolve();
  }

  get<T>(namespace: string, key: string): Promise<T | null> {
    return this.inner.get<T>(this.ns(namespace), key);
  }

  set<T>(namespace: string, key: string, value: T): Promise<void> {
    return this.inner.set<T>(this.ns(namespace), key, value);
  }

  delete(namespace: string, key: string): Promise<void> {
    return this.inner.delete(this.ns(namespace), key);
  }

  list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    return this.inner.list<T>(this.ns(namespace), prefix);
  }

  close(): Promise<void> {
    return this.options.ownsInner === false ? Promise.resolve() : this.inner.close();
  }
}
