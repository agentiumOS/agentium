import { EventEmitter } from "node:events";
import type {
  CreateResponseOpts,
  RealtimeConnection,
  RealtimeEvent,
  RealtimeEventMap,
  RealtimeProvider,
  RealtimeRecoveryContinuity,
  RealtimeRecoveryPolicy,
  RealtimeRecoveryState,
  RealtimeSessionConfig,
} from "./types.js";

const ignoreError = () => {};

function bounded(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`Recovery ${name} must be an integer between ${min} and ${max}`);
  return result;
}

/** One wrapper belongs to one VoiceAgent.connect owner; checkpoints never leave that scope. */
export class RecoveringRealtimeConnection extends EventEmitter implements RealtimeConnection {
  private readonly controller = new AbortController();
  private readonly config: RealtimeSessionConfig;
  private readonly identity: string;
  private readonly maxAttempts: number;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly connectTimeout: number;
  private readonly maxElapsed: number;
  private readonly fallback: "stop" | "fresh";
  private active?: RealtimeConnection;
  private detach: () => void = () => {};
  private removeAbort: () => void = () => {};
  private closed = false;
  private recovering = false;
  private recoveryTask?: Promise<void>;
  private attempts = 0;
  private epoch = 0;
  private checkpoint?: { handle: string; at: number };
  private generating = false;
  private inputPending = false;
  private inputRevision = 0;
  private generationInputRevision = 0;
  private waitingForInput = false;
  private suppressedGeneration = false;
  private goAway = false;
  private readonly pendingTools = new Set<string>();
  private readonly seenTools = new Set<string>();
  private readonly retired = new WeakSet<RealtimeConnection>();
  private effectsUnconfirmed = false;

  private constructor(
    private readonly provider: RealtimeProvider,
    config: RealtimeSessionConfig,
    policy: RealtimeRecoveryPolicy,
  ) {
    super();
    if (!provider.capabilities?.recovery) throw new Error("This realtime provider does not support recovery");
    if (config.mcpServers?.length)
      throw new Error("Managed recovery cannot observe native remote MCP effects; expose them as local tools instead");
    if (config.sessionResumption) throw new Error("Recovery manages its own scoped session checkpoints");
    if (policy.fallback !== undefined && policy.fallback !== "stop" && policy.fallback !== "fresh")
      throw new Error("Recovery fallback must be stop or fresh");
    this.fallback = policy.fallback ?? "stop";
    this.maxAttempts = bounded(policy.maxAttempts, 3, "maxAttempts", 1, 100);
    this.initialDelay = bounded(policy.initialDelayMs, 250, "initialDelayMs", 0, 60_000);
    this.maxDelay = bounded(policy.maxDelayMs, 2_000, "maxDelayMs", this.initialDelay, 60_000);
    this.connectTimeout = bounded(policy.connectTimeoutMs, 10_000, "connectTimeoutMs", 1, 120_000);
    this.maxElapsed = bounded(policy.maxElapsedMs, 30_000, "maxElapsedMs", 1, 300_000);
    this.identity = `${provider.providerId}\0${provider.modelId}`;
    const { signal: _signal, ...configuration } = config;
    this.config = structuredClone(configuration);
    // Native transports can emit errors while their final close is in flight.
    this.on("error", ignoreError);
  }

  static async connect(
    provider: RealtimeProvider,
    config: RealtimeSessionConfig,
    policy: RealtimeRecoveryPolicy,
  ): Promise<RecoveringRealtimeConnection> {
    config.signal?.throwIfAborted();
    const wrapper = new RecoveringRealtimeConnection(provider, config, policy);
    const abort = () => void wrapper.close();
    config.signal?.addEventListener("abort", abort, { once: true });
    wrapper.removeAbort = () => config.signal?.removeEventListener("abort", abort);
    try {
      const connection = await wrapper.open(undefined, wrapper.connectTimeout);
      if (wrapper.closed) {
        wrapper.retire(connection);
        throw new Error("Voice recovery cancelled");
      }
      wrapper.bind(connection);
      return wrapper;
    } catch (error) {
      await wrapper.close();
      throw error;
    }
  }

  get toolContinuation(): "client" | "provider" | undefined {
    return this.active?.toolContinuation;
  }

  private available(): RealtimeConnection {
    if (this.closed || this.recovering || !this.active)
      throw new Error("Voice connection unavailable; wait for recovery before sending new input");
    return this.active;
  }

  private input(): RealtimeConnection {
    const connection = this.available();
    this.checkpoint = undefined;
    this.inputPending = true;
    this.inputRevision++;
    this.waitingForInput = false;
    return connection;
  }

  sendAudio(data: Buffer): void {
    this.input().sendAudio(data);
  }
  sendText(text: string): void {
    this.input().sendText(text);
  }
  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void {
    this.input().sendImage(image, opts);
  }
  commitAudio(): void {
    this.input().commitAudio();
  }
  createResponse(opts?: CreateResponseOpts): void {
    if (this.waitingForInput) throw new Error("Recovery requires new user input before a response");
    const connection = this.available();
    this.checkpoint = undefined;
    this.inputPending = true;
    connection.createResponse(opts);
  }
  sendToolResult(callId: string, result: string): void {
    const connection = this.available();
    if (!this.pendingTools.has(callId)) throw new Error("Unknown or stale realtime tool call");
    this.checkpoint = undefined;
    connection.sendToolResult(callId, result);
    this.pendingTools.delete(callId);
  }
  interrupt(): void {
    this.checkpoint = undefined;
    this.active?.interrupt();
  }

  private retire(connection: RealtimeConnection): void {
    if (this.retired.has(connection)) return;
    this.retired.add(connection);
    connection.on("error", ignoreError);
    // Cleanup never blocks cancellation or another bounded connection attempt.
    try {
      void connection.close().catch(ignoreError);
    } catch {
      // A failed transport close cannot make its detached events current again.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(new Error("Voice recovery cancelled"));
    this.removeAbort();
    this.detach();
    if (this.active) this.retire(this.active);
    this.active = undefined;
    this.checkpoint = undefined;
    this.emit("disconnected", {});
    await this.recoveryTask;
  }

  private bind(connection: RealtimeConnection): void {
    if (connection.connectionState === "closed") {
      this.retire(connection);
      throw new Error("Realtime connection closed during setup");
    }
    this.active = connection;
    const epoch = this.epoch;
    const removers: Array<() => void> = [];
    const listen = <K extends RealtimeEvent>(event: K, handler: (data: RealtimeEventMap[K]) => void) => {
      const guarded = (data: RealtimeEventMap[K]) => {
        if (!this.closed && !this.recovering && epoch === this.epoch) handler(data);
      };
      connection.on(event, guarded);
      removers.push(() => connection.off(event, guarded));
    };
    const id = (value: string | undefined) => (value === undefined ? undefined : `recovery:${epoch}:${value}`);
    const outputAllowed = () => !this.waitingForInput && !this.suppressedGeneration;
    listen("generation_start", (data) => {
      this.generating = true;
      this.generationInputRevision = this.inputRevision;
      this.checkpoint = undefined;
      if (this.waitingForInput) this.suppressedGeneration = true;
      if (outputAllowed()) this.emit("generation_start", { generationId: id(data.generationId) });
    });
    listen("audio", (data) => {
      if (outputAllowed()) this.emit("audio", { ...data, generationId: id(data.generationId) });
    });
    listen("text", (data) => {
      if (outputAllowed()) this.emit("text", data);
    });
    listen("transcript", (data) => {
      if (outputAllowed())
        this.emit("transcript", { ...data, generationId: id(data.generationId), segmentId: id(data.segmentId) });
    });
    listen("turn_complete", (data) => {
      this.generating = false;
      // A late end marker for an older generation cannot acknowledge newer user input.
      this.inputPending = this.inputRevision !== this.generationInputRevision;
      if (outputAllowed()) this.emit("turn_complete", { ...data, generationId: id(data.generationId) });
      this.suppressedGeneration = false;
    });
    listen("tool_call", (data) => {
      if (!outputAllowed() || this.seenTools.has(data.id)) return;
      if (this.seenTools.size >= 1024) {
        this.fail("uncertain-tools");
        return;
      }
      this.checkpoint = undefined;
      this.effectsUnconfirmed = true;
      this.seenTools.add(data.id);
      this.pendingTools.add(data.id);
      this.emit("tool_call", data);
    });
    listen("session_resume", (data) => {
      this.checkpoint = undefined;
      if (
        this.provider.capabilities?.recovery === "session-resumption" &&
        data.resumable === true &&
        typeof data.handle === "string" &&
        data.handle.length > 0 &&
        data.handle.length <= 64_000 &&
        !this.generating &&
        !this.inputPending &&
        !this.pendingTools.size
      ) {
        this.checkpoint = { handle: data.handle, at: Date.now() };
        this.effectsUnconfirmed = false;
      }
      // Raw handles stay private when managed recovery is enabled.
      if (this.goAway && this.checkpoint) this.beginRecovery("go-away");
    });
    listen("go_away", (data) => {
      this.goAway = true;
      this.emit("go_away", data);
      if (this.checkpoint) this.beginRecovery("go-away");
    });
    listen("disconnected", () => this.beginRecovery("disconnected"));
    listen("interrupted", (data) => {
      this.checkpoint = undefined;
      this.emit("interrupted", data);
    });
    listen("usage", (data) => this.emit("usage", data));
    listen("idle", (data) => this.emit("idle", data));
    listen("error", (data) => this.emit("error", data));
    this.detach = () => {
      for (const remove of removers) remove();
    };
  }

  private state(state: RealtimeRecoveryState): void {
    this.emit("recovery", state);
  }

  private fail(reason: RealtimeRecoveryState["reason"]): void {
    this.state({ status: "failed", reason, attempt: this.attempts, requiresInput: true });
    this.emit("interrupted", {});
    void this.close();
  }

  private beginRecovery(reason: "disconnected" | "go-away"): void {
    if (this.closed || this.recovering) return;
    if (this.pendingTools.size || this.effectsUnconfirmed) {
      this.fail("uncertain-tools");
      return;
    }
    const checkpoint =
      this.checkpoint && Date.now() - this.checkpoint.at < 2 * 60 * 60 * 1000 ? this.checkpoint.handle : undefined;
    const continuity: RealtimeRecoveryContinuity = checkpoint ? "session-resumption" : "fresh";
    if (!checkpoint && this.fallback !== "fresh") {
      this.fail("unsafe-checkpoint");
      return;
    }
    this.recovering = true;
    this.detach();
    const previous = this.active;
    this.active = undefined;
    this.checkpoint = undefined;
    this.epoch++;
    this.emit("interrupted", {});
    if (previous) this.retire(previous);
    this.recoveryTask = this.recover(reason, continuity, checkpoint);
  }

  private async recover(
    reason: "disconnected" | "go-away",
    continuity: RealtimeRecoveryContinuity,
    handle: string | undefined,
  ): Promise<void> {
    const deadline = Date.now() + this.maxElapsed;
    let incidentAttempt = 0;
    while (!this.closed && this.attempts < this.maxAttempts && Date.now() < deadline) {
      this.attempts++;
      this.state({ status: "recovering", reason, attempt: this.attempts, continuity, requiresInput: true });
      try {
        const delay = Math.min(this.maxDelay, this.initialDelay * 2 ** incidentAttempt++);
        await this.delay(Math.min(delay, Math.max(0, deadline - Date.now())));
        if (Date.now() >= deadline) break;
        const connection = await this.open(handle, Math.min(this.connectTimeout, deadline - Date.now()));
        if (this.closed) {
          this.retire(connection);
          return;
        }
        this.generating = false;
        this.inputPending = false;
        this.goAway = false;
        this.waitingForInput = true;
        this.suppressedGeneration = false;
        this.recovering = false;
        this.bind(connection);
        this.state({ status: "recovered", reason, attempt: this.attempts, continuity, requiresInput: true });
        return;
      } catch {
        if (this.closed) return;
      }
    }
    if (!this.closed) this.fail("exhausted");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.controller.signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(this.controller.signal.reason);
      };
      const timer = setTimeout(() => {
        this.controller.signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      this.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }

  private async open(handle: string | undefined, timeoutMs: number): Promise<RealtimeConnection> {
    if (`${this.provider.providerId}\0${this.provider.modelId}` !== this.identity)
      throw new Error("Realtime provider identity changed during recovery");
    this.controller.signal.throwIfAborted();
    const attempt = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, attempt.signal]);
    const timer = setTimeout(() => attempt.abort(new Error("Realtime connection attempt timed out")), timeoutMs);
    let removeAbort = () => {};
    try {
      const pending = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return this.provider.connect({
          ...structuredClone(this.config),
          signal,
          ...(this.provider.capabilities?.recovery === "session-resumption" ? { sessionResumption: { handle } } : {}),
        });
      });
      void pending.then((connection) => {
        if (signal.aborted) this.retire(connection);
      }, ignoreError);
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      removeAbort();
    }
  }
}
