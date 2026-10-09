import { randomUUID } from "node:crypto";
import type { InputReply, InputRequest, InputRequestOptions, MessageContent } from "@agentium/core";
import { z } from "zod/v3";

export type HarnessInputErrorCode =
  | "invalid_input"
  | "input_pending"
  | "input_not_pending"
  | "input_mismatch"
  | "input_already_resolved"
  | "run_finished";

export class HarnessInputError extends Error {
  constructor(
    readonly code: HarnessInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessInputError";
  }
}

const text = z.object({ type: z.literal("text"), text: z.string() }).strict();
const media = z.discriminatedUnion("type", [
  text,
  z
    .object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      data: z.string(),
      mimeType: z.enum(["audio/mp3", "audio/wav", "audio/ogg", "audio/webm"]).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("file"), data: z.string(), mimeType: z.string(), filename: z.string().optional() })
    .strict(),
]);
const message = z.union([z.string(), z.array(media).min(1)]);
const question = z
  .object({
    question: z.string().trim().min(1),
    choices: z.array(z.string().min(1)).min(1).max(100).optional(),
    timeoutMs: z.number().int().positive().safe().optional(),
  })
  .strict();

export function validateRunInput(input: MessageContent): MessageContent {
  const parsed = message.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 65536)
    throw new HarnessInputError("invalid_input", "Input must be valid message content no larger than 64KB");
  return parsed.data;
}

export function validateTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new HarnessInputError("invalid_input", "Timeout must be a positive safe integer");
}

/** Owns live promises only; this is not a restart checkpoint. */
export class LiveInput {
  private pending?: { request: InputRequest; resolve: (reply: InputReply) => void; reject: (error: unknown) => void };
  private resolved = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private activeTimer?: ReturnType<typeof setTimeout>;
  private activeSince = Date.now();
  private activeRemaining: number;
  private closed = false;
  private onAbort = () => {
    const pending = this.pending;
    this.pending = undefined;
    this.clearTimers();
    pending?.reject(this.signal.reason);
  };

  constructor(
    private runId: string,
    private signal: AbortSignal,
    private timeouts: { activeTimeoutMs?: number; inputTimeoutMs?: number },
    private emit: (
      event:
        | { type: "input.requested"; request: InputRequest }
        | { type: "input.resolved"; requestId: string }
        | { type: "run.resumed"; requestId: string },
    ) => void,
    private expire: (code: "input_timeout" | "active_timeout") => void,
  ) {
    this.activeRemaining = timeouts.activeTimeoutMs ?? Infinity;
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (!signal.aborted) this.resumeClock();
  }

  get request(): InputRequest | undefined {
    return this.pending && structuredClone(this.pending.request);
  }

  assertActive(): void {
    if (this.closed || this.signal.aborted) throw new HarnessInputError("run_finished", "Run is no longer active");
  }

  assertNotWaiting(): void {
    this.assertActive();
    if (this.pending)
      throw new HarnessInputError("input_pending", "No model calls are allowed while waiting for input");
  }

  requestInput(options: InputRequestOptions): Promise<InputReply> {
    this.assertNotWaiting();
    const parsed = question.safeParse(options);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 32768)
      throw new HarnessInputError("invalid_input", "Question must be valid and no larger than 32KB");
    const request: InputRequest = { ...parsed.data, id: `${this.runId}:${randomUUID()}`, runId: this.runId };
    const promise = new Promise<InputReply>((resolve, reject) => {
      this.pending = { request, resolve, reject };
    });
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeRemaining -= Date.now() - this.activeSince;
    const timeoutMs = request.timeoutMs ?? this.timeouts.inputTimeoutMs;
    if (timeoutMs !== undefined) {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (Date.now() >= deadline) this.expire("input_timeout");
        else this.timer = setTimeout(tick, Math.min(deadline - Date.now(), 2_147_483_647));
      };
      tick();
    }
    this.emit({ type: "input.requested", request });
    return promise;
  }

  reply(requestId: string, input: MessageContent): void {
    this.assertActive();
    if (this.resolved.has(requestId))
      throw new HarnessInputError("input_already_resolved", "Input request already resolved");
    const pending = this.pending;
    if (!pending) throw new HarnessInputError("input_not_pending", "There is no pending input request");
    if (pending.request.id !== requestId)
      throw new HarnessInputError("input_mismatch", "Reply does not match the pending input request");
    const value = validateRunInput(input);
    // Claim synchronously before resolving or notifying any consumer.
    this.resolved.add(requestId);
    this.pending = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.emit({ type: "input.resolved", requestId });
    this.resumeClock();
    this.emit({ type: "run.resumed", requestId });
    pending.resolve({ requestId, input: value });
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.signal.removeEventListener("abort", this.onAbort);
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new HarnessInputError("run_finished", "Run finished with unresolved input"));
  }

  private resumeClock(): void {
    this.activeSince = Date.now();
    if (!Number.isFinite(this.activeRemaining)) return;
    const tick = () => {
      const remaining = this.activeRemaining - (Date.now() - this.activeSince);
      if (remaining <= 0) this.expire("active_timeout");
      else this.activeTimer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
    };
    tick();
  }
  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.activeTimer) clearTimeout(this.activeTimer);
  }
}
