import {
  type ChatMessage,
  type DurableJSON,
  durableCanonical,
  durableDigest,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  type ToolCallResult,
} from "@agentium/core";
import { z } from "zod/v3";

const jsonSchema: z.ZodType<DurableJSON> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
);
const identifier = z.string().trim().min(1).max(512);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const boundarySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("model.settled"),
      providerId: identifier,
      modelId: identifier,
      requestDigest: digest,
      output: jsonSchema,
    })
    .strict(),
  z.object({ type: z.literal("tools.settled"), results: z.array(jsonSchema).min(1) }).strict(),
]);
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterId: identifier,
    adapterVersion: identifier,
    configurationDigest: digest,
    scopeDigest: digest,
    initialState: jsonSchema,
    initialStateDigest: digest,
    records: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          boundary: boundarySchema,
          boundaryDigest: digest,
          previousStateDigest: digest,
          state: jsonSchema,
          stateDigest: digest,
        })
        .strict(),
    ),
  })
  .strict();

/** Complete portable observations, in native conversation order. Tool results are
 * one complete settled batch in declaration order, never completion order. */
export type HarnessRecoveryBoundary = z.infer<typeof boundarySchema>;
export type HarnessRecoveryState = z.infer<typeof stateSchema>;

export interface HarnessRecoveryStateAdapter {
  id: string;
  version: string;
  /** Host commitment to executable/configuration versions, including tools,
   * skills, context, reducers and middleware. Never include credentials. */
  configuration: DurableJSON;
  captureInitialState(): DurableJSON | Promise<DurableJSON>;
  restoreState(state: DurableJSON): void | Promise<void>;
  /** Pure transition: do not mutate closures, persist, call tools or emit events.
   * Inputs are frozen. Move application mutations into this ordered reducer. */
  reduce(state: DurableJSON, boundary: HarnessRecoveryBoundary): DurableJSON | Promise<DurableJSON>;
}

/** Application-state lifecycle only. This does not replay providers, checkpoint
 * the Agent cursor, recover questions/streams or make a native driver durable.
 * Persistence must use the caller's existing task fence and atomic transaction. */
export interface HarnessRecoveryLifecycleOptions {
  adapter: HarnessRecoveryStateAdapter;
  state?: HarnessRecoveryState;
  persist(state: HarnessRecoveryState): Promise<void>;
  /** Reject rather than truncate. Paging/retention needs a separate contract. */
  maxBytes?: number;
  maxRecords?: number;
}

export class HarnessRecoveryLifecycleError extends Error {
  readonly code = "recovery_lifecycle";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessRecoveryLifecycleError";
  }
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate before cloning: class instances, Maps/Sets, undefined and nonfinite
 * numbers must not silently disappear from a recovery checkpoint. */
function portable(value: unknown): DurableJSON {
  const encoded = durableCanonical(value);
  return jsonSchema.parse(JSON.parse(encoded));
}

// Native SDK values have optional object properties. Omit those absences while
// rejecting class instances and undefined array elements through portable().
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

/** Internal normalization at the native port; provider raw responses and API
 * credentials are deliberately excluded from the application-state journal. */
export function modelRecoveryBoundary(
  provider: ModelProvider,
  messages: readonly ChatMessage[],
  options: ModelConfig,
  response: ModelResponse,
): HarnessRecoveryBoundary {
  const { apiKey: _apiKey, signal: _signal, ...requestOptions } = options;
  return {
    type: "model.settled",
    providerId: provider.providerId,
    modelId: provider.modelId,
    requestDigest: durableDigest(defined({ messages, options: requestOptions })),
    output: portable(
      defined({
        message: response.message,
        usage: response.usage,
        finishReason: response.finishReason,
        publicMessages: response.publicMessages,
        decisions: response.decisions,
      }),
    ),
  };
}

export function toolsRecoveryBoundary(results: readonly ToolCallResult[]): HarnessRecoveryBoundary {
  return { type: "tools.settled", results: results.map((result) => portable(defined(result))) };
}

/** Creates one causal cursor for one native execution attempt. On restoration,
 * only the initial state is exposed; retained later states become visible after
 * the corresponding exact boundary is encountered. */
export function createHarnessRecoveryLifecycle(options: HarnessRecoveryLifecycleOptions, scope: unknown) {
  // Pin behavior for this attempt; caller mutation must not replace callbacks
  // after the identity has been validated.
  const adapter = { ...options.adapter };
  const persist = options.persist;
  const identity = {
    schemaVersion: 1 as const,
    adapterId: identifier.parse(adapter.id),
    adapterVersion: identifier.parse(adapter.version),
    configurationDigest: durableDigest(adapter.configuration),
    scopeDigest: durableDigest(scope),
  };
  const maxBytes = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(options.maxBytes ?? 1_000_000);
  const maxRecords = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(options.maxRecords ?? 1_000);
  let retained = options.state === undefined ? undefined : stateSchema.parse(portable(options.state));
  let current: DurableJSON = null;
  let cursor = 0;
  let initialized = false;
  let queue = Promise.resolve();
  let failure: unknown;

  function validate(state: HarnessRecoveryState) {
    if (Object.entries(identity).some(([key, value]) => Reflect.get(state, key) !== value))
      throw new HarnessRecoveryLifecycleError("Recovery adapter, configuration or run scope differs");
    if (state.records.length > maxRecords || Buffer.byteLength(durableCanonical(state)) > maxBytes)
      throw new HarnessRecoveryLifecycleError("Recovery lifecycle retention limit exceeded");
    let previous = durableDigest(state.initialState);
    if (previous !== state.initialStateDigest)
      throw new HarnessRecoveryLifecycleError("Recovery initial state digest differs");
    for (const [sequence, record] of state.records.entries()) {
      if (
        record.sequence !== sequence ||
        record.previousStateDigest !== previous ||
        record.boundaryDigest !== durableDigest(record.boundary) ||
        record.stateDigest !== durableDigest(record.state)
      )
        throw new HarnessRecoveryLifecycleError("Recovery state transition chain differs");
      previous = record.stateDigest;
    }
  }
  if (retained) validate(retained);

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      if (failure !== undefined)
        throw new HarnessRecoveryLifecycleError("Recovery lifecycle is stopped", { cause: failure });
      try {
        return await operation();
      } catch (error) {
        failure = error ?? new Error("Recovery operation failed");
        throw error;
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    initialize: () =>
      enqueue(async () => {
        if (initialized) throw new HarnessRecoveryLifecycleError("Recovery lifecycle already initialized");
        if (!retained) {
          const initialState = portable(await adapter.captureInitialState());
          const candidate = { ...identity, initialState, initialStateDigest: durableDigest(initialState), records: [] };
          validate(candidate);
          await persist(frozen(structuredClone(candidate)));
          retained = candidate;
        }
        current = structuredClone(retained.initialState);
        await adapter.restoreState(frozen(structuredClone(current)));
        initialized = true;
      }),
    settle: (input: HarnessRecoveryBoundary) => {
      // Copy at invocation, before another asynchronous operation can mutate it.
      const boundary = boundarySchema.parse(portable(input));
      return enqueue(async () => {
        if (!initialized || !retained) throw new HarnessRecoveryLifecycleError("Recovery lifecycle is not initialized");
        const previous = retained.records[cursor];
        if (previous) {
          if (previous.boundaryDigest !== durableDigest(boundary))
            throw new HarnessRecoveryLifecycleError("Recovery boundary differs from the retained causal sequence");
          current = structuredClone(previous.state);
        } else {
          const state = portable(
            await adapter.reduce(frozen(structuredClone(current)), frozen(structuredClone(boundary))),
          );
          const record = {
            sequence: cursor,
            boundary,
            boundaryDigest: durableDigest(boundary),
            previousStateDigest: durableDigest(current),
            state,
            stateDigest: durableDigest(state),
          };
          const candidate = { ...retained, records: [...retained.records, record] };
          validate(candidate);
          // Do not expose a new state until its durable write acknowledges.
          await persist(frozen(structuredClone(candidate)));
          retained = candidate;
          current = structuredClone(state);
        }
        cursor++;
        await adapter.restoreState(frozen(structuredClone(current)));
      });
    },
    idle: () =>
      enqueue(async () => {
        if (!initialized) throw new HarnessRecoveryLifecycleError("Recovery lifecycle is not initialized");
      }),
    finish: () =>
      enqueue(async () => {
        if (!initialized || !retained || cursor !== retained.records.length)
          throw new HarnessRecoveryLifecycleError("Execution ended before replaying all retained recovery boundaries");
      }),
  };
}
