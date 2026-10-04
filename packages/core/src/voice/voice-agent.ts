import { randomUUID as uuidv4 } from "node:crypto";
import { EventEmitter } from "node:events";
import { RunContext } from "../agent/run-context.js";
import { EventBus } from "../events/event-bus.js";
import { Logger } from "../logger/logger.js";
import { MemoryManager } from "../memory/memory-manager.js";
import type { ChatMessage } from "../models/types.js";
import { SkillManager } from "../skills/skill-manager.js";
import { ApprovalManager } from "../tools/approval.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type { ToolDef } from "../tools/types.js";
import { RecoveringRealtimeConnection } from "./recovery.js";
import type {
  RealtimeConnection,
  RealtimeSessionConfig,
  RealtimeToolCall,
  TurnDetectionConfig,
  VoiceAgentConfig,
  VoiceRecording,
  VoiceSession,
  VoiceSessionEvent,
  VoiceSessionEventMap,
} from "./types.js";

class VoiceSessionImpl extends EventEmitter implements VoiceSession {
  private connection: RealtimeConnection;
  private transcripts: { role: "user" | "assistant"; text: string }[];
  private outputChunks: Buffer[] = [];
  private inputChunks: Buffer[] = [];
  private recordOutput: boolean;
  private recordInput: boolean;
  private recordedBytes = 0;
  private readonly maxRecordingBytes = 16 * 1024 * 1024;
  private deliveries = new Map<
    string,
    { index: number; text: string; played: number; done: boolean; closed?: boolean }
  >();

  observeAssistant(generationId: string, text: string, done: boolean): void {
    let delivery = this.deliveries.get(generationId);
    if (!delivery) {
      if (this.deliveries.size >= 1024) throw new Error("Voice transcript generation limit exceeded");
      delivery = { index: this.transcripts.length, text, played: 0, done };
      this.deliveries.set(generationId, delivery);
      this.transcripts.push({ role: "assistant", text: "[Speech delivery unconfirmed]" });
    }
    if (delivery.closed) return;
    delivery.text = text;
    delivery.done = done;
  }
  interruptDelivery(): void {
    // Preserve the acknowledged prefix; late acknowledgements cannot make cleared audio heard.
    for (const delivery of this.deliveries.values()) delivery.closed = true;
  }
  acknowledgePlayback(ack: import("./speech-types.js").PlaybackAck): void {
    const delivery = this.deliveries.get(ack.generationId);
    if (!delivery || delivery.closed) return;
    if (ack.complete && !delivery.done) throw new Error("Generation has not completed");
    const played = ack.complete ? delivery.text.length : ack.playedCharacters;
    if (!Number.isSafeInteger(played) || played! < delivery.played || played! > delivery.text.length)
      throw new Error("Invalid playback acknowledgement");
    delivery.played = played!;
    this.transcripts[delivery.index].text =
      delivery.text.slice(0, played) + (ack.complete ? "" : " [Speech delivery unconfirmed beyond this point]");
  }
  private record(data: Buffer, chunks: Buffer[]): void {
    if (this.recordedBytes + data.byteLength > this.maxRecordingBytes)
      throw new Error("Voice recording exceeds 16 MiB; use a streaming recording sink");
    this.recordedBytes += data.byteLength;
    chunks.push(Buffer.from(data));
  }

  constructor(
    connection: RealtimeConnection,
    transcripts: { role: "user" | "assistant"; text: string }[],
    recording?: { output?: boolean; input?: boolean },
  ) {
    super();
    this.on("error", (err) => {
      console.error("[VoiceSession] Unhandled error:", err);
    });
    this.connection = connection;
    this.transcripts = transcripts;
    this.recordOutput = !!recording?.output;
    this.recordInput = !!recording?.input;
  }

  sendAudio(data: Buffer): void {
    if (this.recordInput) this.record(data, this.inputChunks);
    this.connection.sendAudio(data);
  }

  sendText(text: string): void {
    this.connection.sendText(text);
  }

  sendImage(image: Buffer | string, opts?: { mimeType?: string; text?: string }): void {
    this.connection.sendImage(image, opts);
  }

  commitAudio(): void {
    this.connection.commitAudio();
  }

  interrupt(): void {
    this.interruptDelivery();
    this.connection.interrupt();
  }

  async close(): Promise<void> {
    this.interruptDelivery();
    await this.connection.close();
  }

  getTranscript(): string {
    return this.transcripts.map((t) => `${t.role}: ${t.text}`).join("\n");
  }

  getRecording(): VoiceRecording {
    return {
      output: Buffer.concat(this.outputChunks),
      input: Buffer.concat(this.inputChunks),
    };
  }

  pushOutputAudio(data: Buffer): void {
    if (this.recordOutput) this.record(data, this.outputChunks);
  }

  on<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): this {
    return super.on(event, handler as any);
  }

  off<K extends VoiceSessionEvent>(event: K, handler: (data: VoiceSessionEventMap[K]) => void): this {
    return super.off(event, handler as any);
  }
}

function applyBargeIn(
  td: TurnDetectionConfig | null | undefined,
  bargeIn?: "always" | "never",
): TurnDetectionConfig | null | undefined {
  if (td === null) return null;
  const interrupt = bargeIn !== "never";
  if (!td) {
    return { type: "semantic_vad", eagerness: "low", interruptResponse: interrupt, createResponse: true };
  }
  return { ...td, interruptResponse: td.interruptResponse ?? interrupt };
}

export class VoiceAgent {
  readonly name: string;
  private config: VoiceAgentConfig;
  private eventBus: EventBus;
  private logger: Logger;
  private toolExecutor: ToolExecutor | null;
  private tools: ToolDef[] = [];
  readonly approvalManager: ApprovalManager | null;

  private createExecutor(): ToolExecutor | null {
    return this.tools.length
      ? new ToolExecutor(this.tools, {
          approvalManager: this.approvalManager ?? undefined,
          executionPolicy: this.config.executionPolicy,
          agentName: this.name,
        })
      : null;
  }
  private memoryManager: MemoryManager | null = null;
  private readonly memoryTenantId?: string;
  private memoryOwner?: string;
  private skillManager: SkillManager | null = null;
  private skillsInitialized = false;
  private skillsLoading?: Promise<void>;

  get audioFormats(): {
    input: import("./speech-types.js").SpeechFormat;
    output: import("./speech-types.js").SpeechFormat;
  } {
    const format = (encoding: string | undefined, rate: number): import("./speech-types.js").SpeechFormat => ({
      encoding: encoding === "g711_ulaw" ? "mulaw" : encoding === "g711_alaw" ? "alaw" : "pcm_s16le",
      channels: 1,
      sampleRateHz: encoding?.startsWith("g711") ? 8000 : rate,
    });
    return {
      input: format(this.config.inputAudioFormat, this.config.provider.capabilities?.inputSampleRateHz ?? 24000),
      output: format(this.config.outputAudioFormat, this.config.provider.capabilities?.outputSampleRateHz ?? 24000),
    };
  }

  get memory(): MemoryManager | null {
    return this.memoryManager;
  }

  constructor(config: VoiceAgentConfig) {
    if ((config as unknown as { prompt?: unknown }).prompt !== undefined)
      throw new Error("Realtime prompt objects are no longer supported; resolve them to app-owned instructions");
    if (config.mcpServers?.length && (config.executionPolicy || config.approval || config.approvalManager))
      throw new Error(
        "Native remote MCP tools cannot be intercepted by local voice policy; register MCP functions as local tools instead",
      );
    this.name = config.name;
    this.config = config;
    this.eventBus = config.eventBus ?? new EventBus();
    this.approvalManager =
      config.approvalManager ??
      (config.approval ? new ApprovalManager({ ...config.approval, eventBus: this.eventBus }) : null);
    this.logger = new Logger({
      level: config.logLevel ?? "silent",
      prefix: config.name,
    });

    if (config.memory) {
      this.memoryTenantId = config.memory.tenantId;
      this.memoryManager = new MemoryManager(config.memory);
    }

    if (config.skills && config.skills.length > 0) {
      this.skillManager = new SkillManager(config.skills as any[]);
    }

    const allTools = [...(config.tools ?? [])];
    if (this.memoryManager) {
      allTools.push(...this.memoryManager.getTools());
    }

    this.tools = allTools;
    this.toolExecutor = this.createExecutor();
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsLoading) return this.skillsLoading;
    if (this.skillsInitialized || !this.skillManager) return;
    const manager = this.skillManager;
    const operation = (async () => {
      const skillTools = await manager.getTools();
      if (skillTools.length > 0) {
        this.tools = [...(this.config.tools ?? []), ...(this.memoryManager?.getTools() ?? []), ...skillTools];
        this.toolExecutor = this.createExecutor();
      }
      this.skillsInitialized = true;
    })().finally(() => {
      if (this.skillsLoading === operation) this.skillsLoading = undefined;
    });
    this.skillsLoading = operation;
    return operation;
  }

  async connect(opts?: {
    apiKey?: string;
    signal?: AbortSignal;
    tenantId?: string;
    runMode?: import("../tools/execution-policy.js").RunMode;
    sessionId?: string;
    userId?: string;
    /** Prior call transcript — appended to instructions (warm transfer). */
    resumeTranscript?: string;
  }): Promise<VoiceSession> {
    if (opts?.signal?.aborted) throw new Error("Voice session cancelled");
    const tenantId = opts?.tenantId ?? this.memoryTenantId;
    const userId = opts?.userId ?? this.config.userId;
    if (this.memoryManager) {
      if (this.memoryTenantId !== undefined && tenantId !== this.memoryTenantId)
        throw new Error("Voice memory tenant does not match the configured tenant");
      const owner = JSON.stringify([tenantId ?? null, userId ?? null]);
      if (this.memoryOwner !== undefined && this.memoryOwner !== owner)
        throw new Error(
          "Memory-enabled VoiceAgent is bound to another tenant or user; use a separately scoped instance",
        );
      // Reserve synchronously before any await: concurrent connects cannot claim a different owner.
      this.memoryOwner = owner;
    }
    await this.ensureSkillsLoaded();
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? `voice_${uuidv4()}`;

    let instructions = this.config.instructions ?? "";

    if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      const memoryContext = await this.memoryManager.buildContext(sessionId, userId, undefined, this.name);
      if (memoryContext) {
        instructions = instructions ? `${instructions}\n\n${memoryContext}` : memoryContext;
      }
    }

    if (this.skillManager) {
      const skillInstructions = await this.skillManager.getInstructions();
      if (skillInstructions) {
        instructions = instructions ? `${instructions}\n\n${skillInstructions}` : skillInstructions;
      }
    }

    if (opts?.resumeTranscript) {
      instructions = `${instructions}\n\nPrior call transcript (warm transfer):\n${opts.resumeTranscript}`;
    }

    const sessionConfig: RealtimeSessionConfig = {
      signal: opts?.signal,
      instructions,
      voice: this.config.voice,
      tools: toolDefs,
      inputAudioFormat: this.config.inputAudioFormat,
      outputAudioFormat: this.config.outputAudioFormat,
      turnDetection:
        this.config.provider.providerId === "google-live"
          ? this.config.turnDetection !== undefined
            ? this.config.turnDetection
            : this.config.bargeIn === "never"
              ? { type: "server_vad", interruptResponse: false }
              : undefined
          : applyBargeIn(this.config.turnDetection, this.config.bargeIn),
      temperature: this.config.temperature,
      maxResponseOutputTokens: this.config.maxResponseOutputTokens,
      apiKey: opts?.apiKey,
      reasoningEffort:
        this.config.reasoningEffort ?? (this.config.provider.providerId === "openai-realtime" ? "low" : undefined),
      transcriptionModel: this.config.transcriptionModel,
      transcriptionContext: this.config.transcriptionContext,
      noiseReduction: this.config.noiseReduction,
      mcpServers: this.config.mcpServers,
      safetyIdentifier: this.config.safetyIdentifier,
      translation: this.config.translation,
    };

    opts?.signal?.throwIfAborted();
    this.logger.info("Connecting to realtime provider...");
    const connection = this.config.recovery
      ? await RecoveringRealtimeConnection.connect(this.config.provider, sessionConfig, this.config.recovery)
      : await this.config.provider.connect(sessionConfig);
    if (opts?.signal?.aborted) {
      await connection.close();
      opts.signal.throwIfAborted();
    }
    const transcripts: { role: "user" | "assistant"; text: string }[] = [];
    const session = new VoiceSessionImpl(connection, transcripts, this.config.recording);

    const controller = new AbortController();
    const ctx = new RunContext({
      sessionId,
      userId,
      tenantId,
      runMode: opts?.runMode,
      signal: controller.signal,
      executionPolicy: this.config.executionPolicy,
      eventBus: this.eventBus,
      metadata: { agentName: this.name },
    });

    let persisted = false;

    const cancelTools = this.wireEvents(connection, session, ctx, transcripts, this.createExecutor());
    const originalInterrupt = session.interrupt.bind(session);
    session.interrupt = () => {
      cancelTools();
      originalInterrupt();
    };
    const abort = () => {
      void session.close().catch((error) => this.logger.warn(String(error)));
    };

    const onSessionEnd = async () => {
      if (persisted) return;
      persisted = true;
      controller.abort();
      cancelTools();
      this.approvalManager?.cancelRun(ctx.runId);
      opts?.signal?.removeEventListener("abort", abort);
      await this.persistSession(sessionId, userId, transcripts);
    };

    session.on("disconnected", () => {
      onSessionEnd().catch((e) => this.logger.warn(`Session persist failed: ${e}`));
    });

    const originalClose = session.close.bind(session);
    let closing: Promise<void> | undefined;
    session.close = async () => {
      if (closing) return closing;
      closing = (async () => {
        controller.abort();
        cancelTools();
        try {
          await originalClose();
        } finally {
          await onSessionEnd();
        }
      })();
      return closing;
    };
    opts?.signal?.addEventListener("abort", abort, { once: true });
    if (opts?.signal?.aborted) {
      await session.close();
      opts.signal.throwIfAborted();
    }

    this.eventBus.emit("voice.connected", { agentName: this.name });
    this.logger.info(`Voice session connected (session=${sessionId}, user=${userId ?? "anonymous"})`);

    return session;
  }

  /**
   * Warm-transfer: close `from`, open a session on this agent with the same transcript.
   */
  async handoff(from: VoiceSession, opts?: { apiKey?: string; userId?: string }): Promise<VoiceSession> {
    const transcript = from.getTranscript();
    await from.close();
    return this.connect({ apiKey: opts?.apiKey, userId: opts?.userId, resumeTranscript: transcript });
  }

  private consolidateTranscripts(transcripts: { role: "user" | "assistant"; text: string }[]): ChatMessage[] {
    const consolidated: ChatMessage[] = [];
    let current: { role: "user" | "assistant"; content: string } | null = null;

    for (const t of transcripts) {
      if (current && current.role === t.role) {
        current.content += t.text;
      } else {
        if (current?.content.trim()) {
          consolidated.push(current);
        }
        current = { role: t.role, content: t.text };
      }
    }
    if (current?.content.trim()) {
      consolidated.push(current);
    }

    return consolidated;
  }

  private async persistSession(
    sessionId: string,
    userId: string | undefined,
    transcripts: { role: "user" | "assistant"; text: string }[],
  ): Promise<void> {
    if (transcripts.length === 0) return;

    const messages = this.consolidateTranscripts(transcripts);

    this.logger.info(`Consolidated ${transcripts.length} transcript deltas into ${messages.length} messages`);
    for (const m of messages) {
      const content = typeof m.content === "string" ? m.content : "";
      this.logger.info(`  [${m.role}] ${content.substring(0, 100)}`);
    }

    if (this.memoryManager) {
      try {
        await this.memoryManager.appendMessages(sessionId, messages, this.config.model);
      } catch (e: any) {
        this.logger.warn(`Session persist failed: ${e.message ?? e}`);
      }

      this.memoryManager.afterRun(sessionId, userId, messages, this.config.model, this.name);
    }
  }

  private wireEvents(
    connection: RealtimeConnection,
    session: VoiceSessionImpl,
    ctx: RunContext,
    transcripts: { role: "user" | "assistant"; text: string }[],
    executor: ToolExecutor | null,
  ): () => void {
    const pending = new Set<AbortController>();
    const seenCalls = new Set<string>();
    const seenSegments = new Set<string>();
    let turnComplete = false;
    let needsContinuation = false;
    const continueTurn = () => {
      if (
        connection.toolContinuation !== "client" ||
        !turnComplete ||
        !needsContinuation ||
        pending.size ||
        ctx.signal?.aborted
      )
        return;
      needsContinuation = false;
      turnComplete = false;
      connection.createResponse(
        this.config.toolCallBehavior === "speakAfter"
          ? { instructions: "Read the tool result back to the user in one short sentence." }
          : undefined,
      );
    };
    connection.on("generation_start", (data) => {
      turnComplete = false;
      session.emit("generation_start", data);
    });
    connection.on("turn_complete", (data) => {
      turnComplete = true;
      session.emit("turn_complete", data);
      continueTurn();
    });
    connection.on("go_away", (data) => session.emit("go_away", data));
    connection.on("session_resume", (data) => session.emit("session_resume", data));
    connection.on("recovery", (data) => session.emit("recovery", data));
    const cancelTools = () => {
      for (const controller of pending) controller.abort();
      pending.clear();
      needsContinuation = false;
    };
    connection.on("audio", (data) => {
      try {
        session.pushOutputAudio(data.data);
      } catch (error) {
        session.emit("error", { error });
        void session.close();
        return;
      }
      session.emit("audio", data);
      this.eventBus.emit("voice.audio", {
        agentName: this.name,
        data: data.data,
      });
    });

    connection.on("text", (data) => {
      session.emit("text", data);
    });

    connection.on("transcript", (data) => {
      session.emit("transcript", data);
      if (data.text.length > 64_000 || transcripts.length > 2048) {
        session.emit("error", { error: new Error("Voice transcript limit exceeded") });
        void session.close();
        return;
      }
      if (data.role === "assistant")
        session.observeAssistant(
          data.generationId ?? data.segmentId ?? `legacy:${transcripts.length}`,
          data.text,
          data.kind !== "partial",
        );
      if (data.kind === "partial") return;
      if (data.segmentId && seenSegments.has(data.segmentId)) return;
      if (data.segmentId) seenSegments.add(data.segmentId);
      if (data.role === "user") transcripts.push({ role: data.role, text: data.text });
      this.eventBus.emit("voice.transcript", {
        agentName: this.name,
        text: data.text,
        role: data.role,
      });
      this.logger.info(`[${data.role}] ${data.text}`);
    });

    connection.on("tool_call", (toolCall: RealtimeToolCall) => {
      if (ctx.signal?.aborted || seenCalls.has(toolCall.id)) return;
      if (seenCalls.size >= 1024) {
        session.emit("error", { error: new Error("Voice tool call limit exceeded") });
        void session.close();
        return;
      }
      seenCalls.add(toolCall.id);
      needsContinuation = true;
      const controller = new AbortController();
      pending.add(controller);
      const callContext = new RunContext({
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        eventBus: ctx.eventBus,
        sessionState: ctx.sessionState,
        metadata: ctx.metadata,
        dependencies: ctx.dependencies,
        runMode: ctx.runMode,
        executionPolicy: ctx.executionPolicy,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
      });
      void this.handleToolCall(connection, session, callContext, toolCall, executor)
        .catch((error) => this.logger.error(`Voice tool dispatch failed: ${String(error)}`))
        .finally(() => {
          pending.delete(controller);
          continueTurn();
        });
    });

    connection.on("interrupted", () => {
      session.interruptDelivery();
      cancelTools();
      session.emit("interrupted", {});
      this.logger.debug("Response interrupted by user speech");
    });

    connection.on("idle", () => {
      session.emit("idle", {});
    });

    connection.on("error", (data) => {
      session.emit("error", data);
      this.eventBus.emit("voice.error", {
        agentName: this.name,
        error: data.error,
      });
      this.logger.error(`Error: ${data.error.message}`);
    });

    connection.on("usage", (data) => {
      session.emit("usage", data);
      if (this.config.costTracker) {
        this.config.costTracker.track({
          runId: ctx.runId,
          agentName: this.name,
          modelId: this.config.provider.modelId,
          usage: data,
          sessionId: ctx.sessionId,
          userId: ctx.userId,
        });
      }
      this.logger.debug(`Usage: ${data.totalTokens} tokens`);
    });

    connection.on("disconnected", () => {
      cancelTools();
      session.emit("disconnected", {});
      this.eventBus.emit("voice.disconnected", { agentName: this.name });
      this.logger.info("Voice session disconnected");
    });
    return cancelTools;
  }

  private async handleToolCall(
    connection: RealtimeConnection,
    session: VoiceSessionImpl,
    ctx: RunContext,
    toolCall: RealtimeToolCall,
    executor: ToolExecutor | null,
  ): Promise<void> {
    if (ctx.signal?.aborted) return;
    if (!executor) {
      this.logger.warn(`Tool call "${toolCall.name}" received but no tools registered`);
      connection.sendToolResult(toolCall.id, JSON.stringify({ error: "No tools available" }));
      return;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(toolCall.arguments || "{}");
    } catch {
      connection.sendToolResult(toolCall.id, JSON.stringify({ error: "Invalid JSON tool arguments" }));
      return;
    }

    session.emit("tool_call_start", {
      name: toolCall.name,
      args: parsedArgs,
    });

    this.eventBus.emit("voice.tool.call", {
      agentName: this.name,
      toolName: toolCall.name,
      args: parsedArgs,
    });

    this.logger.info(`Tool call: ${toolCall.name}`);

    try {
      const results = await executor.executeAll([{ id: toolCall.id, name: toolCall.name, arguments: parsedArgs }], ctx);

      if (ctx.signal?.aborted) return;
      const result = results[0];
      const resultContent = typeof result.result === "string" ? result.result : result.result.content;

      connection.sendToolResult(toolCall.id, resultContent);

      session.emit("tool_result", {
        name: toolCall.name,
        result: resultContent,
      });

      this.eventBus.emit("voice.tool.result", {
        agentName: this.name,
        toolName: toolCall.name,
        result: resultContent,
      });

      this.logger.info(`Tool result: ${toolCall.name} -> ${resultContent.substring(0, 100)}`);
    } catch (error: any) {
      if (ctx.signal?.aborted) return;
      const errMsg = error?.message ?? "Tool execution failed";
      connection.sendToolResult(toolCall.id, JSON.stringify({ error: errMsg }));
      this.logger.error(`Tool error: ${toolCall.name} -> ${errMsg}`);
    }
  }
}
