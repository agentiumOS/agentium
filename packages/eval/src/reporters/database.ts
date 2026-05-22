import type { StorageDriver } from "@agentium/core";
import type { EvalSuiteResult, Reporter } from "../types.js";

export interface DatabaseReporterConfig {
  storage: StorageDriver;
  namespace?: string;
}

export class DatabaseReporter implements Reporter {
  private storage: StorageDriver;
  private namespace: string;

  constructor(config: DatabaseReporterConfig) {
    this.storage = config.storage;
    this.namespace = config.namespace ?? "eval_results";
  }

  async report(result: EvalSuiteResult): Promise<void> {
    const key = `${result.name}_${Date.now()}`;
    await this.storage.set(this.namespace, key, result);
  }
}
