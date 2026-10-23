import { AsyncLocalStorage } from "node:async_hooks";
import {
  type DurableJSON,
  durableCanonical,
  durableDigest,
  type InputReply,
  type InputRequest,
  type ModelResponse,
  type StreamChunk,
  type ToolResult,
} from "@agentium/core";
import { z } from "zod/v3";

function isJSON(value: unknown, seen = new Set<object>()): value is DurableJSON {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const valid = Object.values(value).every((item) => isJSON(item, seen));
  seen.delete(value);
  return valid;
}
const jsonSchema = z.custom<DurableJSON>(isJSON);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const maxSnapshotBytes = 128_000_000;
const snapshotTextSchema = z.union([
  z.string(),
  z
    .object({
      encoding: z.literal("chunks-v1"),
      digest: digestSchema,
      bytes: z.number().int().nonnegative().max(maxSnapshotBytes),
      characters: z.number().int().nonnegative().max(maxSnapshotBytes),
      chunks: z.array(digestSchema).max(32_768),
    })
    .strict(),
]);
const snapshotSchema = z.object({ applicationJSON: snapshotTextSchema, harnessJSON: snapshotTextSchema }).strict();
const snapshotChunkSchema = z.object({ version: z.literal(1), data: z.string() }).strict();
const envelopeSchema = z
  .object({ version: z.literal(1), valueJSON: snapshotTextSchema, snapshot: snapshotSchema })
  .strict();
const text = z.string();
const toolCall = z.object({ id: text.min(1), name: text.min(1), arguments: z.record(z.unknown()) });
const message = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([text, z.null(), z.array(z.object({ type: text }).passthrough())]),
  toolCalls: z.array(toolCall).optional(),
  toolCallId: text.optional(),
  name: text.optional(),
  providerExtras: z.record(z.unknown()).optional(),
  phase: z.enum(["commentary", "final"]).optional(),
});
const usage = z
  .object({
    promptTokens: z.number().nonnegative(),
    completionTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  })
  .passthrough();
const responseSchema = z
  .object({
    message,
    usage,
    finishReason: z.enum(["stop", "tool_calls", "length", "content_filter"]),
    raw: z.unknown(),
  })
  .passthrough();
function isModelResponse(value: unknown): value is ModelResponse {
  return responseSchema.safeParse(value).success;
}
export function parseNativeModelResponse(value: unknown): ModelResponse {
  const restored = { ...z.record(z.unknown()).parse(value), raw: null };
  if (!isModelResponse(restored)) throw new TypeError("Invalid retained native model response");
  return restored;
}
export function parseNativeToolResult(value: unknown): string | ToolResult {
  if (typeof value === "string") return value;
  return z
    .object({
      content: z.string(),
      artifacts: z.array(z.object({ type: z.string(), data: jsonSchema, mimeType: z.string().optional() })).optional(),
    })
    .parse(value);
}

/** Host implementation must atomically verify input identity and retain complete
 * output under the existing task lease/fence. Rejected work is not completion.
 * `snapshot-chunk` operations contain immutable content-addressed text, have no
 * application effects, and may safely retry an interrupted write. Keep their
 * outputs for the same lifetime as the operations that reference them. */
export interface HarnessNativeJournal {
  operation(id: string, input: DurableJSON, execute: () => Promise<DurableJSON>): Promise<DurableJSON>;
}
export interface HarnessNativeRecoveryOptions {
  /** Stable logical task identity, shared across replacement workers. */
  taskId: string;
  /** Pinned executable, tool/skill and policy identities; never credentials. */
  configuration: DurableJSON;
  journal: HarnessNativeJournal;
  application?: {
    capture(): DurableJSON | Promise<DurableJSON>;
    restore(state: DurableJSON): void | Promise<void>;
  };
  /** Return a durably accepted answer, or throw HarnessNativeInputPending after
   * durably recording the question. Never hold an open worker for a human wait. */
  requestInput?(request: InputRequest): Promise<InputReply>;
  /** Bound each journal envelope, including immutable snapshot fragments. */
  maxRecordBytes?: number;
}
export class HarnessNativeInputPending extends Error {
  readonly code = "native_input_pending";
  constructor(readonly request: InputRequest) {
    super("Native task is awaiting durable user input");
    this.name = "HarnessNativeInputPending";
  }
}
/** Also recognizes the equivalent class from the package's other module format. */
export function isHarnessNativeInputPending(error: unknown): error is HarnessNativeInputPending {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "native_input_pending" || !("request" in error))
    return false;
  return z
    .object({
      id: z.string().min(1),
      runId: z.string().min(1),
      question: z.string().min(1),
      choices: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .safeParse(error.request).success;
}
/** Journal, snapshot, and retained-value failures stop execution rather than
 * becoming model-visible tool failures that could start another effect. */
export class HarnessNativeRecoveryError extends Error {
  readonly code = "native_recovery_failed";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Native recovery failed", { cause });
    this.name = "HarnessNativeRecoveryError";
  }
}

function defined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(defined);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, defined(item)]),
    );
  return value;
}
export function nativeJSON(value: unknown): DurableJSON {
  return JSON.parse(JSON.stringify(jsonSchema.parse(defined(value))));
}
function canonicalJSON(value: unknown): string {
  const item = nativeJSON(value);
  const order = (next: DurableJSON): DurableJSON => {
    if (Array.isArray(next)) return next.map(order);
    if (next !== null && typeof next === "object")
      return Object.fromEntries(
        Object.keys(next)
          .sort()
          .map((key) => [key, order(next[key])]),
      );
    return next;
  };
  return JSON.stringify(order(item));
}

// Content-defined boundaries survive insertions earlier in a growing history.
// A fixed-width split would rewrite every later fragment whenever a counter or
// message changes length. The rolling hash forgets its prefix after 32 symbols.
const snapshotGear = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index + 1;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
});
function* snapshotChunks(value: string, maximum: number): Generator<string> {
  const minimum = Math.min(4096, maximum);
  let start = 0;
  let rolling = 0;
  for (let index = 0; index < value.length; index++) {
    rolling = ((rolling << 1) + snapshotGear[value.charCodeAt(index) & 255]) >>> 0;
    const length = index + 1 - start;
    if (length >= maximum || (length >= minimum && (rolling & 8191) === 0)) {
      // JSONB and other UTF-8 stores reject an unpaired UTF-16 surrogate. Carry
      // a complete code point into the current fragment before cutting it.
      const character = value.charCodeAt(index);
      const next = value.charCodeAt(index + 1);
      if (character >= 0xd800 && character <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) continue;
      yield value.slice(start, index + 1);
      start = index + 1;
      rolling = 0;
    }
  }
  if (start < value.length) yield value.slice(start);
}
// Hash the JSON string, preserving even a fragment split inside a surrogate pair.
const snapshotDigest = (value: string) => durableDigest(value).slice("sha256:".length);
export function nativeModelValue(value: ModelResponse): DurableJSON {
  const { raw: _raw, ...response } = value;
  return nativeJSON(response);
}
export function nativeRequestOptions(value: object | undefined): DurableJSON {
  if (!value) return {};
  const record = z
    .custom<Record<string, unknown>>((item) => typeof item === "object" && item !== null && !Array.isArray(item))
    .parse(value);
  const { apiKey: _apiKey, signal: _signal, ...options } = record;
  return nativeJSON(options);
}
function isStreamChunk(value: unknown): value is StreamChunk {
  const item = z.object({ type: text }).passthrough().safeParse(value);
  if (!item.success) return false;
  switch (item.data.type) {
    case "text":
    case "thinking":
    case "reasoning_summary":
      return z.object({ text }).safeParse(value).success;
    case "tool_call_start":
      return z.object({ toolCall: z.object({ id: text, name: text }) }).safeParse(value).success;
    case "tool_call_delta":
      return z.object({ toolCallId: text, argumentsDelta: text }).safeParse(value).success;
    case "tool_call_end":
      return z.object({ toolCallId: text }).safeParse(value).success;
    case "public_message":
      return z.object({ event: z.object({ type: text }).passthrough() }).safeParse(value).success;
    case "finish":
      return z.object({ finishReason: text }).safeParse(value).success;
    default:
      return false;
  }
}
function parseChunks(value: unknown): StreamChunk[] {
  if (!Array.isArray(value) || !value.every(isStreamChunk)) throw new TypeError("Invalid retained native stream");
  return value;
}

/** SDK-owned replay around the native driver, never a second agent loop. */
export function createHarnessNativeRecovery(
  options: HarnessNativeRecoveryOptions,
  scope: unknown,
  snapshots: {
    capture(): DurableJSON | Promise<DurableJSON>;
    restore(state: DurableJSON): void | Promise<void>;
  },
) {
  const configurationDigest = durableDigest(canonicalJSON(options.configuration));
  const scopeDigest = durableDigest(canonicalJSON(scope));
  const journal = options.journal;
  const application = options.application;
  const maxBytes = z
    .number()
    .int()
    .positive()
    .parse(options.maxRecordBytes ?? 4_000_000);
  const context = new AsyncLocalStorage<{ path: string; next: number; tail: Promise<void> }>();
  const root = { path: "native", next: 0, tail: Promise.resolve() };
  const retainedChunks = new Map<string, string>();
  // JSON escaping can use six bytes per UTF-16 symbol. Leave room for the
  // envelope and reject an unusually small configured limit in the same path.
  const chunkCharacters = Math.max(1, Math.min(16_384, Math.floor((maxBytes - 256) / 6)));
  const checkRecord = (value: unknown) => {
    if (Buffer.byteLength(durableCanonical(nativeJSON(value))) > maxBytes)
      throw new RangeError("Native recovery record exceeds its byte limit");
  };
  const retainChunk = async (digest: string, data?: string): Promise<string> => {
    const cached = retainedChunks.get(digest);
    if (cached !== undefined) return cached;
    const result = await journal.operation(
      `native/snapshot/${digest}`,
      { version: 1, kind: "snapshot-chunk", configurationDigest, scopeDigest, inputJSON: canonicalJSON({ digest }) },
      async () => {
        if (data === undefined) throw new Error(`Missing retained native snapshot fragment: ${digest}`);
        const chunk = { version: 1, data };
        checkRecord(chunk);
        return chunk;
      },
    );
    const chunk = snapshotChunkSchema.parse(result);
    checkRecord(chunk);
    if (snapshotDigest(chunk.data) !== digest) throw new Error(`Invalid retained native snapshot fragment: ${digest}`);
    retainedChunks.set(digest, chunk.data);
    return chunk.data;
  };
  const retainText = async (value: string): Promise<z.infer<typeof snapshotTextSchema>> => {
    if (value.length < Math.min(4096, chunkCharacters)) return value;
    const bytes = Buffer.byteLength(value);
    if (bytes > maxSnapshotBytes) throw new RangeError("Native recovery snapshot exceeds its byte limit");
    const chunks: string[] = [];
    for (const data of snapshotChunks(value, chunkCharacters)) {
      const digest = snapshotDigest(data);
      await retainChunk(digest, data);
      chunks.push(digest);
    }
    return snapshotTextSchema.parse({
      encoding: "chunks-v1",
      digest: snapshotDigest(value),
      bytes,
      characters: value.length,
      chunks,
    });
  };
  const restoreText = async (value: z.infer<typeof snapshotTextSchema>): Promise<string> => {
    if (typeof value === "string") return value;
    const chunks: string[] = [];
    let characters = 0;
    for (const digest of value.chunks) {
      const chunk = await retainChunk(digest);
      characters += chunk.length;
      if (characters > value.characters) throw new Error("Native snapshot fragment lengths do not match");
      chunks.push(chunk);
    }
    const text = chunks.join("");
    if (
      characters !== value.characters ||
      Buffer.byteLength(text) !== value.bytes ||
      snapshotDigest(text) !== value.digest
    )
      throw new Error("Native snapshot fragments do not match the retained checkpoint");
    return text;
  };
  const capture = async (includeApplication: boolean) => ({
    applicationJSON: await retainText(
      canonicalJSON(application && includeApplication ? await application.capture() : null),
    ),
    harnessJSON: await retainText(canonicalJSON(await snapshots.capture())),
  });
  const restore = async (snapshot: z.infer<typeof snapshotSchema>, includeApplication: boolean) => {
    // Resolve and validate both texts before mutating either causal state owner.
    const harnessJSON = await restoreText(snapshot.harnessJSON);
    const applicationJSON = await restoreText(snapshot.applicationJSON);
    const harnessState = jsonSchema.parse(JSON.parse(harnessJSON));
    const applicationState = jsonSchema.parse(JSON.parse(applicationJSON));
    await snapshots.restore(harnessState);
    if (application && includeApplication) await application.restore(applicationState);
  };
  async function execute<T>(
    id: string,
    kind: string,
    input: unknown,
    run: () => Promise<unknown>,
    parse: (value: unknown) => T,
    settledBoundary = true,
  ): Promise<T> {
    // Parsing a valid retained negative tool result is an ordinary tool error.
    // Persistence, validation and restoration failures must escape the executor.
    let value: DurableJSON;
    let operationFailed = false;
    let operationError: unknown;
    try {
      // Tool/input request fields remain directly readable by domain receipt and
      // question reconcilers. Other large inputs are immutable identity payloads;
      // retain their text once instead of repeating a full projected history.
      const originalInput = canonicalJSON(input);
      const retainedInput = kind === "tool" || kind === "input" ? originalInput : await retainText(originalInput);
      const inputJSON =
        typeof retainedInput === "string" ? retainedInput : canonicalJSON({ nativeInput: retainedInput });
      const operationInput = { version: 1, kind, configurationDigest, scopeDigest, inputJSON };
      checkRecord(operationInput);
      const result = await journal.operation(id, operationInput, async () => {
        return context.run({ path: id, next: 0, tail: Promise.resolve() }, async () => {
          let value: unknown;
          try {
            value = await run();
          } catch (error) {
            operationFailed = true;
            operationError = error;
            throw error;
          }
          // Nested model/control/input decisions can run during an active
          // context projection or tool. Journal their result only; the enclosing
          // settled boundary owns both snapshots. Restoring transient snapshots
          // here would replace state that the outer continuation still owns.
          const envelope = {
            version: 1,
            valueJSON: await retainText(canonicalJSON(value === undefined ? null : value)),
            snapshot: settledBoundary ? await capture(true) : { applicationJSON: "null", harnessJSON: "null" },
          };
          checkRecord(envelope);
          return envelope;
        });
      });
      const envelope = envelopeSchema.parse(result);
      checkRecord(envelope);
      value = jsonSchema.parse(JSON.parse(await restoreText(envelope.valueJSON)));
      if (settledBoundary) await restore(envelope.snapshot, true);
    } catch (error) {
      if (operationFailed && error === operationError) throw error;
      if (isHarnessNativeInputPending(error) || error instanceof HarnessNativeRecoveryError) throw error;
      throw new HarnessNativeRecoveryError(error);
    }
    try {
      return parse(value);
    } catch (error) {
      throw new HarnessNativeRecoveryError(error);
    }
  }
  const run = <T>(
    kind: string,
    input: unknown,
    operation: (id: string) => Promise<unknown>,
    parse: (value: unknown) => T,
  ) => {
    const parent = context.getStore() ?? root;
    const id = `${parent.path}/${parent.next++}-${kind}`;
    const result = parent.tail.then(() => execute(id, kind, input, () => operation(id), parse, parent === root));
    parent.tail = result.then(() => undefined);
    // A failed sibling poisons this causal frame, so queued work cannot execute
    // after lease loss. Keep its rejection observed even with no later sibling.
    void parent.tail.catch(() => {});
    return result;
  };
  return {
    initialize: () =>
      execute(
        "native/initial",
        "initial",
        {},
        async () => null,
        () => undefined,
      ),
    run,
    async *stream(
      input: unknown,
      operation: (signal: AbortSignal) => AsyncGenerator<StreamChunk>,
    ): AsyncGenerator<StreamChunk> {
      const controller = new AbortController();
      const queue: StreamChunk[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let failure: unknown;
      let fresh = false;
      const pending = run(
        "stream",
        input,
        async () => {
          fresh = true;
          const chunks: StreamChunk[] = [];
          controller.signal.throwIfAborted();
          for await (const chunk of operation(controller.signal)) {
            controller.signal.throwIfAborted();
            chunks.push(chunk);
            queue.push(chunk);
            wake?.();
          }
          controller.signal.throwIfAborted();
          return nativeJSON(chunks);
        },
        parseChunks,
      )
        .then(
          (chunks) => {
            if (!fresh) queue.push(...chunks);
          },
          (error: unknown) => {
            failure = error;
          },
        )
        .finally(() => {
          done = true;
          wake?.();
        });
      try {
        while (!done || queue.length) {
          const chunk = queue.shift();
          if (chunk) {
            yield chunk;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure !== undefined) throw failure;
      } finally {
        // Closing the consumer must interrupt a pending provider read before
        // waiting for its cleanup. An interrupted response cannot be retained.
        if (!done) controller.abort();
        await pending;
      }
    },
  };
}
