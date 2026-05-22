import type { StorageDriver } from "./driver.js";

export interface StorageScope {
  /** Tenant / organization identifier. */
  tenantId?: string;
  /** User identifier within the tenant. */
  userId?: string;
}

/**
 * Wraps any `StorageDriver` and namespaces every key by tenant / user, providing
 * multi-tenant isolation without requiring per-driver changes.
 *
 * Namespace transformation:
 *   "sessions" + scope { tenantId: "acme", userId: "u1" }
 *   -> "tenant:acme:user:u1:sessions"
 */
export class ScopedStorage implements StorageDriver {
  constructor(
    private readonly inner: StorageDriver,
    private readonly scope: StorageScope,
  ) {}

  private ns(namespace: string): string {
    const parts: string[] = [];
    if (this.scope.tenantId) parts.push(`tenant:${this.scope.tenantId}`);
    if (this.scope.userId) parts.push(`user:${this.scope.userId}`);
    parts.push(namespace);
    return parts.join(":");
  }

  initialize(): Promise<void> {
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
    return this.inner.close();
  }
}
