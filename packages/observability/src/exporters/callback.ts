import type { Trace, TraceExporter } from "../types.js";

export class CallbackExporter implements TraceExporter {
  name = "callback";
  private callback: (trace: Trace) => void | Promise<void>;

  constructor(callback: (trace: Trace) => void | Promise<void>) {
    this.callback = callback;
  }

  async export(trace: Trace): Promise<void> {
    await this.callback(trace);
  }
}
