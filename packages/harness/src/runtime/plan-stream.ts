import type { DurableJSON } from "@agentium/core";
import { z } from "zod/v3";
import { ExecutionPlanValidationError } from "./execution-proposal.js";
import type { PlanCommitFrame, PlanStreamLimits } from "./graph-contracts.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const json: z.ZodType<DurableJSON> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);
const frameSchema = z
  .object({
    baseRevision: integer,
    plan: z
      .object({
        schemaVersion: z.literal(1),
        revision: integer.positive(),
        nodes: z.array(
          z
            .object({
              id: z.string(),
              binding: z.string(),
              version: z.string(),
              args: z.record(json),
              dependsOn: z.array(z.string()).optional(),
              inputsFrom: z.array(z.string()).optional(),
            })
            .strict(),
        ),
        maxConcurrency: integer.positive().optional(),
        merge: z.enum(["error", "declaration_order"]).optional(),
      })
      .strict(),
  })
  .strict();

/** Bound a suspended iterator/model wait even when no new fragment arrives. */
export async function awaitPlanningOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("Planning aborted"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Decode only closed NDJSON frames. Partial/trailing JSON never becomes executable. */

export async function* decodePlanCommitFrames(
  source: AsyncIterable<string>,
  limits: PlanStreamLimits,
  signal?: AbortSignal,
  onFrame?: (raw: string) => Promise<void>,
): AsyncGenerator<PlanCommitFrame> {
  integer.positive().parse(limits.maxFrameBytes);
  integer.parse(limits.maxTotalBytes);
  integer.parse(limits.maxFrames);
  let buffered = "";
  let bytes = 0;
  let frames = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await awaitPlanningOperation(iterator.next(), signal);
      if (next.done) break;
      const chunk = next.value;
      signal?.throwIfAborted();
      if (typeof chunk !== "string") throw new ExecutionPlanValidationError("Planning stream requires text");
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf("\n", offset);
        const end = newline < 0 ? chunk.length : newline;
        const before = Buffer.byteLength(buffered);
        buffered += chunk.slice(offset, end);
        bytes += Buffer.byteLength(buffered) - before + (newline < 0 ? 0 : 1);
        if (Buffer.byteLength(buffered) > limits.maxFrameBytes || bytes > limits.maxTotalBytes)
          throw new ExecutionPlanValidationError("Planning stream exceeds its byte limit");
        if (newline < 0) break;
        const text = buffered.trim();
        buffered = "";
        offset = end + 1;
        if (!text) continue;
        if (++frames > limits.maxFrames)
          throw new ExecutionPlanValidationError("Planning stream exceeds its frame limit");
        await onFrame?.(text);
        try {
          yield frameSchema.parse(JSON.parse(text));
        } catch (cause) {
          throw new ExecutionPlanValidationError("Malformed planning commit frame", { cause });
        }
      }
    }
  } finally {
    const closing = iterator.return?.();
    if (signal?.aborted) closing?.catch(() => {});
    else await closing;
  }
  signal?.throwIfAborted();
  if (buffered.trim()) throw new ExecutionPlanValidationError("Planning stream ended with a truncated frame");
}
