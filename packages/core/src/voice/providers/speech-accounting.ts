import { beginMeteredOperation } from "../../cost/accounting.js";
import { normalizeSpeechUsage } from "../../cost/operation-usage.js";
import type { SpeechUsage } from "../speech-types.js";
import type { SpeechWireOptions } from "./speech-socket.js";

/** Character and duration measurements are preserved with measured provenance, never asserted invoice totals. */
export async function beginSpeechAccounting(
  options: SpeechWireOptions,
  providerId: string,
  modelId: string,
  api: string,
  signal: AbortSignal,
) {
  const attempt = await beginMeteredOperation({
    accounting: options.accounting,
    context: { providerId, billingProviderId: providerId, modelId, api, occurredAt: new Date().toISOString() },
    signal,
  });
  const abort = () => {
    void attempt.finish("cancelled");
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    record: (usage: SpeechUsage) => {
      attempt.capture(normalizeSpeechUsage(usage.provider, usage.unit, usage.quantity));
      options.onUsage?.(usage);
    },
    close: async () => {
      signal.removeEventListener("abort", abort);
      await attempt.finish(signal.aborted ? "cancelled" : "succeeded");
    },
    fail: async () => {
      signal.removeEventListener("abort", abort);
      await attempt.finish(signal.aborted ? "cancelled" : "failed");
    },
  };
}
