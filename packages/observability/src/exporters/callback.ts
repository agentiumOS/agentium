import { Capture, type TelemetryOptions } from "../safety.js";
import type { Trace, TraceExporter } from "../types.js";

export class CallbackExporter implements TraceExporter {
  name = "callback";
  private capture: Capture;
  private callback: (trace: Trace) => void | Promise<void>;

  constructor(callback: (trace: Trace) => void | Promise<void>, options: TelemetryOptions = {}) {
    this.capture = new Capture(options);
    this.callback = callback;
  }

  async export(trace: Trace): Promise<void> {
    await this.callback(this.capture.trace(trace));
  }
}
