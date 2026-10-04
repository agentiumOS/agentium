import { appendFile, writeFile } from "node:fs/promises";
import { Capture, type TelemetryOptions } from "../safety.js";
import type { Trace, TraceExporter } from "../types.js";

export interface JsonFileExporterConfig extends TelemetryOptions {
  path?: string;
  mode?: "overwrite" | "append";
  pretty?: boolean;
}

export class JsonFileExporter implements TraceExporter {
  name = "json-file";
  private capture: Capture;
  private path: string;
  private mode: "overwrite" | "append";
  private pretty: boolean;

  constructor(config?: JsonFileExporterConfig) {
    this.capture = new Capture(config);
    this.mode = config?.mode ?? "append";
    this.path = config?.path ?? `traces-${Date.now()}.${this.mode === "append" ? "jsonl" : "json"}`;
    this.pretty = config?.pretty ?? this.mode === "overwrite";
  }

  async export(raw: Trace): Promise<void> {
    const trace = this.capture.trace(raw);
    const json = this.pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace);

    try {
      if (this.mode === "append") {
        await appendFile(this.path, `${json}\n`);
      } else {
        await writeFile(this.path, json);
      }
    } catch {
      this.capture.diagnostic.report("file_export_failed");
      throw new Error("Telemetry file write failed");
    }
  }
}
