export interface StorageDriver {
  initialize?(): Promise<void>;
  get<T>(namespace: string, key: string): Promise<T | null>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list<T>(namespace: string, prefix?: string): Promise<Array<{ key: string; value: T }>>;
  close(): Promise<void>;
}
