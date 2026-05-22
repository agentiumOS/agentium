import { appendFile, writeFile } from "node:fs/promises";
import type { Trace, TraceExporter } from "../types.js";

export interface JsonFileExporterConfig {
  path?: string;
  mode?: "overwrite" | "append";
  pretty?: boolean;
}

export class JsonFileExporter implements TraceExporter {
  name = "json-file";
  private path: string;
  private mode: "overwrite" | "append";
  private pretty: boolean;

  constructor(config?: JsonFileExporterConfig) {
    this.mode = config?.mode ?? "append";
    this.path = config?.path ?? `traces-${Date.now()}.${this.mode === "append" ? "jsonl" : "json"}`;
    this.pretty = config?.pretty ?? true;
  }

  async export(trace: Trace): Promise<void> {
    const json = this.pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace);

    try {
      if (this.mode === "append") {
        await appendFile(this.path, `${json}\n`);
      } else {
        await writeFile(this.path, json);
      }
    } catch (err) {
      console.warn(
        `[agentium/observability] Failed to write trace to ${this.path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
