import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import { RunContext } from "../agent/run-context.js";
import { EventBus } from "../events/event-bus.js";
import { Logger } from "../logger/logger.js";
import { MemoryManager } from "../memory/memory-manager.js";
import type { ChatMessage } from "../models/types.js";
import { SkillManager } from "../skills/skill-manager.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import type {
  VisionAgentConfig,
  VisionConnection,
  VisionSession,
  VisionSessionConfig,
  VisionSessionEvent,
  VisionSessionEventMap,
  VisionToolCall,
} from "./types.js";

class VisionSessionImpl extends EventEmitter implements VisionSession {
  private connection: VisionConnection;

  constructor(connection: VisionConnection) {
    super();
    this.on("error", (err) => {
      console.error("[VisionSession] Unhandled error:", err);
    });
    this.connection = connection;
  }

  sendAudio(data: Buffer): void {
    this.connection.sendAudio(data);
  }

  sendImage(data: Buffer, mimeType?: string): void {
    this.connection.sendImage(data, mimeType);
  }

  sendText(text: string): void {
    this.connection.sendText(text);
  }

  interrupt(): void {
    this.connection.interrupt();
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  on<K extends VisionSessionEvent>(event: K, handler: (data: VisionSessionEventMap[K]) => void): this {
    return super.on(event, handler as any);
  }

  off<K extends VisionSessionEvent>(event: K, handler: (data: VisionSessionEventMap[K]) => void): this {
    return super.off(event, handler as any);
  }
}

export class VisionAgent {
  readonly name: string;
  private config: VisionAgentConfig;
  private eventBus: EventBus;
  private logger: Logger;
  private toolExecutor: ToolExecutor | null;
  private memoryManager: MemoryManager | null = null;
  private skillManager: SkillManager | null = null;
  private skillsInitialized = false;

  get memory(): MemoryManager | null {
    return this.memoryManager;
  }

  constructor(config: VisionAgentConfig) {
    this.name = config.name;
    this.config = config;
    this.eventBus = config.eventBus ?? new EventBus();
    this.logger = new Logger({
      level: config.logLevel ?? "silent",
      prefix: config.name,
    });

    if (config.memory) {
      this.memoryManager = new MemoryManager(config.memory);
    }

    if (config.skills && config.skills.length > 0) {
      this.skillManager = new SkillManager(config.skills as any[]);
    }

    const allTools = [...(config.tools ?? [])];
    if (this.memoryManager) {
      allTools.push(...this.memoryManager.getTools());
    }

    this.toolExecutor = allTools.length > 0 ? new ToolExecutor(allTools) : null;
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (this.skillsInitialized || !this.skillManager) return;
    this.skillsInitialized = true;

    const skillTools = await this.skillManager.getTools();
    if (skillTools.length > 0) {
      const allTools = [...(this.config.tools ?? [])];
      if (this.memoryManager) allTools.push(...this.memoryManager.getTools());
      allTools.push(...skillTools);
      this.toolExecutor = new ToolExecutor(allTools);
    }
  }

  async connect(opts?: { apiKey?: string; sessionId?: string; userId?: string }): Promise<VisionSession> {
    await this.ensureSkillsLoaded();
    const toolDefs = this.toolExecutor?.getToolDefinitions() ?? [];
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? `vision_${uuidv4()}`;
    const userId = opts?.userId ?? this.config.userId;

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

    const sessionConfig: VisionSessionConfig = {
      instructions,
      voice: this.config.voice,
      language: this.config.language,
      tools: toolDefs,
      temperature: this.config.temperature,
      fps: this.config.fps,
      thinkingLevel: this.config.thinkingLevel,
      apiKey: opts?.apiKey,
    };

    this.logger.info("Connecting to vision provider...");
    const connection = await this.config.provider.connect(sessionConfig);
    const session = new VisionSessionImpl(connection);

    const ctx = new RunContext({
      sessionId,
      userId,
      eventBus: this.eventBus,
      metadata: { agentName: this.name },
    });

    const transcripts: { role: "user" | "assistant"; text: string }[] = [];
    let persisted = false;

    this.wireEvents(connection, session, ctx, transcripts);

    const onSessionEnd = async () => {
      if (persisted) return;
      persisted = true;
      await this.persistSession(sessionId, userId, transcripts);
    };

    session.on("disconnected", () => {
      onSessionEnd().catch((e) => this.logger.warn(`Session persist failed: ${e}`));
    });

    const originalClose = session.close.bind(session);
    session.close = async () => {
      await originalClose();
      await onSessionEnd();
    };

    this.eventBus.emit("voice.connected", { agentName: this.name });
    this.logger.info(`Vision session connected (session=${sessionId}, user=${userId ?? "anonymous"})`);

    return session;
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
    connection: VisionConnection,
    session: VisionSessionImpl,
    ctx: RunContext,
    transcripts: { role: "user" | "assistant"; text: string }[],
  ): void {
    connection.on("audio", (data) => {
      session.emit("audio", data);
      this.eventBus.emit("voice.audio", { agentName: this.name, data: data.data });
    });

    connection.on("text", (data) => {
      session.emit("text", data);
    });

    connection.on("transcript", (data) => {
      session.emit("transcript", data);
      transcripts.push({ role: data.role, text: data.text });
      this.eventBus.emit("voice.transcript", { agentName: this.name, text: data.text, role: data.role });
      this.logger.info(`[${data.role}] ${data.text}`);
    });

    connection.on("tool_call", (toolCall: VisionToolCall) => {
      this.handleToolCall(connection, session, ctx, toolCall);
    });

    connection.on("interrupted", () => {
      session.emit("interrupted", {});
      this.logger.debug("Response interrupted by user speech");
    });

    connection.on("error", (data) => {
      session.emit("error", data);
      this.eventBus.emit("voice.error", { agentName: this.name, error: data.error });
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
      session.emit("disconnected", {});
      this.eventBus.emit("voice.disconnected", { agentName: this.name });
      this.logger.info("Vision session disconnected");
    });
  }

  private async handleToolCall(
    connection: VisionConnection,
    session: VisionSessionImpl,
    ctx: RunContext,
    toolCall: VisionToolCall,
  ): Promise<void> {
    if (!this.toolExecutor) {
      this.logger.warn(`Tool call "${toolCall.name}" received but no tools registered`);
      connection.sendToolResult(toolCall.id, JSON.stringify({ error: "No tools available" }));
      return;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(toolCall.arguments || "{}");
    } catch {
      parsedArgs = {};
    }

    session.emit("tool_call_start", { name: toolCall.name, args: parsedArgs });
    this.eventBus.emit("voice.tool.call", { agentName: this.name, toolName: toolCall.name, args: parsedArgs });
    this.logger.info(`Tool call: ${toolCall.name}`);

    try {
      const results = await this.toolExecutor.executeAll(
        [{ id: toolCall.id, name: toolCall.name, arguments: parsedArgs }],
        ctx,
      );

      const result = results[0];
      const resultContent = typeof result.result === "string" ? result.result : result.result.content;

      connection.sendToolResult(toolCall.id, resultContent);
      session.emit("tool_result", { name: toolCall.name, result: resultContent });
      this.eventBus.emit("voice.tool.result", { agentName: this.name, toolName: toolCall.name, result: resultContent });
      this.logger.info(`Tool result: ${toolCall.name} -> ${resultContent.substring(0, 100)}`);
    } catch (error: any) {
      const errMsg = error?.message ?? "Tool execution failed";
      connection.sendToolResult(toolCall.id, JSON.stringify({ error: errMsg }));
      this.logger.error(`Tool error: ${toolCall.name} -> ${errMsg}`);
    }
  }
}
