import type { ModelProvider } from "../models/provider.js";
import type { StorageDriver } from "../storage/driver.js";

export interface MemoryConfig {
  storage?: StorageDriver;
  /** LLM used to generate conversation summaries from overflow messages. */
  model?: ModelProvider;
  /** Maximum number of summaries kept per session (oldest dropped first). Default 20. */
  maxSummaries?: number;
}

export interface MemoryEntry {
  key: string;
  summary: string;
  createdAt: Date;
}
