import type { StorageDriver } from "../storage/driver.js";

export class TenantScopedStorage implements StorageDriver {
  private inner: StorageDriver;
  private tenantId: string;

  constructor(inner: StorageDriver, tenantId: string) {
    this.inner = inner;
    this.tenantId = tenantId;
  }

  private scopeNamespace(namespace: string): string {
    return `t:${this.tenantId}:${namespace}`;
  }

  async initialize(): Promise<void> {
    if (this.inner.initialize) await this.inner.initialize();
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    return this.inner.get<T>(this.scopeNamespace(namespace), key);
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    return this.inner.set<T>(this.scopeNamespace(namespace), key, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    return this.inner.delete(this.scopeNamespace(namespace), key);
  }

  async list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>> {
    return this.inner.list<T>(this.scopeNamespace(namespace), prefix);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  getTenantId(): string {
    return this.tenantId;
  }
}
