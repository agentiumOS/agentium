import { v4 as uuidv4 } from "uuid";
import type { SemanticCache } from "../cache/semantic-cache.js";
import { CompressionManager } from "../compression/compression-manager.js";
import { ContextCompactor } from "../context/context-compactor.js";
import { CultureManager } from "../culture/culture-manager.js";
import { applyTemplates, resolveDependencies } from "../dependencies/resolver.js";
import { EventBus } from "../events/event-bus.js";
import { HandoffManager } from "../handoff/handoff-manager.js";
import { createHandoffTool } from "../handoff/handoff-tool.js";
import { HandoffSignal } from "../handoff/types.js";
import { Logger } from "../logger/logger.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { type ChatMessage, getTextContent, type MessageContent, type StreamChunk } from "../models/types.js";
import { registry } from "../serve.js";
import { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/types.js";
import { SkillManager } from "../skills/skill-manager.js";
import { createArtifactTools } from "../state/artifact-tools.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRouter } from "../tools/tool-router.js";
import { countTokens } from "../utils/token-counter.js";
import type { WebhookManager } from "../webhooks/webhook-manager.js";
import { RunCancelledError } from "./errors.js";
import { LLMLoop } from "./llm-loop.js";
import { ReflectionManager } from "./reflection.js";
import { RunContext } from "./run-context.js";
import {
  buildAgentConfigFromSerialized,
  type DeserializeRegistry,
  type SerializedAgent,
  serializeAgentConfig,
} from "./serialization.js";
import type { AgentConfig, LoopHooks, RunMetrics, RunOpts, RunOutput } from "./types.js";

export class Agent {
  readonly kind = "agent" as const;
  readonly name: string;
  readonly eventBus: EventBus;
  readonly instructions?: string | ((ctx: RunContext) => string);

  private config: AgentConfig;
  private memoryManager: MemoryManager | null = null;
  private skillManager: SkillManager | null = null;
  private handoffManager: HandoffManager | null = null;
  private webhookManager: WebhookManager | null = null;
  private semanticCache: SemanticCache | null = null;
  private compressionManager: CompressionManager | null = null;
  private cultureManager: CultureManager | null = null;
  private reflectionManager: ReflectionManager | null = null;
  private fallbackSessionManager: SessionManager | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: assigned in rebuildLLMLoop, kept for future use
  private llmLoop!: LLMLoop;
  private logger: Logger;
  private readyPromise: Promise<void>;
  private _toolExecutor: ToolExecutor | null = null;
  private toolRouter: ToolRouter | null = null;
  private skillsInitPromise: Promise<void> | null = null;

  get tools() {
    return this.config.tools ?? [];
  }

  /** Replace the agent's tool set at runtime (e.g. after MCP servers connect/disconnect). */
  setTools(tools: import("../tools/types.js").ToolDef[]): void {
    this.config.tools = tools;
    this.rebuildLLMLoop();
  }

  /** Add a single tool at runtime. */
  addTool(tool: import("../tools/types.js").ToolDef): void {
    this.config.tools = [...(this.config.tools ?? []), tool];
    this.rebuildLLMLoop();
  }

  /** Remove a tool by name at runtime. Returns true if the tool was found and removed. */
  removeTool(name: string): boolean {
    const before = this.config.tools?.length ?? 0;
    this.config.tools = (this.config.tools ?? []).filter((t) => t.name !== name);
    if (this.config.tools.length !== before) {
      this.rebuildLLMLoop();
      return true;
    }
    return false;
  }

  /** List the names of all currently registered tools. */
  listTools(): string[] {
    return this.collectTools(this.config).map((t) => t.name);
  }

  private buildToolExecutorConfig(): import("../tools/tool-executor.js").ToolExecutorConfig {
    return {
      sandbox: this.config.sandbox,
      approval: this.config.approval ? { ...this.config.approval, eventBus: this.eventBus } : undefined,
      agentName: this.config.name,
      onToolCall: this.config.hooks?.onToolCall
        ? (ctx, toolName, args) => this.config.hooks!.onToolCall!(ctx, toolName, args)
        : undefined,
      artifacts: this.config.artifacts?.enabled
        ? {
            maxToolOutputBytes: this.config.artifacts.maxToolOutputBytes ?? 50 * 1024,
            previewChars: this.config.artifacts.previewChars ?? 200,
          }
        : undefined,
    };
  }

  private buildLoopHooks(): LoopHooks | undefined {
    const userHooks = this.config.loopHooks;
    const compactor = this.config.contextCompactor ? new ContextCompactor(this.config.contextCompactor) : null;
    const costTracker = this.config.costTracker;
    const compression = this.compressionManager;

    if (!userHooks && !compactor && !costTracker && !compression) return undefined;

    return {
      beforeLLMCall: async (messages, roundtrip) => {
        let result: import("../models/types.js").ChatMessage[] | undefined;
        if (compression) {
          const compressed = await compression.process(messages, this.config.model.modelId);
          if (compressed) result = compressed;
        }
        if (compactor) {
          result = await compactor.compact(result ?? messages);
        }
        if (userHooks?.beforeLLMCall) {
          const userResult = await userHooks.beforeLLMCall(result ?? messages, roundtrip);
          if (userResult) result = userResult;
        }
        return result;
      },
      afterLLMCall: userHooks?.afterLLMCall,
      beforeToolExec: userHooks?.beforeToolExec,
      afterToolExec: userHooks?.afterToolExec,
      onRoundtripComplete: async (roundtrip, tokensSoFar) => {
        // Mid-run budget check without persisting an entry (avoids double-counting)
        if (costTracker) {
          const exceeded = costTracker.checkInProgressBudget(this.config.model.modelId, tokensSoFar);
          if (exceeded) {
            return { stop: true };
          }
        }

        if (userHooks?.onRoundtripComplete) {
          return userHooks.onRoundtripComplete(roundtrip, tokensSoFar);
        }
      },
    };
  }

  private rebuildLLMLoop(): void {
    const allTools = this.collectTools(this.config);
    this._toolExecutor = allTools.length > 0 ? new ToolExecutor(allTools, this.buildToolExecutorConfig()) : null;
    this.llmLoop = new LLMLoop(this.config.model, this._toolExecutor, {
      maxToolRoundtrips: this.config.maxToolRoundtrips ?? 10,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      structuredOutput: this.config.structuredOutput,
      logger: this.logger,
      reasoning: this.config.reasoning,
      retry: this.config.retry,
      toolResultLimit: this.config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
    });
  }

  get modelId(): string {
    return this.config.model.modelId;
  }

  get providerId(): string {
    return this.config.model.providerId;
  }

  get hasStructuredOutput(): boolean {
    return !!this.config.structuredOutput;
  }

  get approvalManager() {
    return this._toolExecutor?.getApprovalManager() ?? null;
  }

  get structuredOutputSchema(): import("zod").ZodSchema | undefined {
    return this.config.structuredOutput;
  }

  /** Access the MemoryManager (if memory is configured). */
  get memory(): MemoryManager | null {
    return this.memoryManager;
  }

  /** Access the CheckpointManager (if checkpointing is configured). */
  get checkpointManager() {
    return (this.config as any)._checkpointManager ?? null;
  }

  constructor(config: AgentConfig) {
    this.config = config;
    this.name = config.name;
    this.instructions = config.instructions;
    this.eventBus = config.eventBus ?? new EventBus();

    if (config.reflection?.enabled) {
      this.reflectionManager = new ReflectionManager(config.reflection, config.model);
    }

    if (config.memory) {
      // Pass the agent's eventBus down so memory extraction errors etc.
      // surface in observability rather than being silently console.warned.
      this.memoryManager = new MemoryManager({ ...config.memory, eventBus: config.memory.eventBus ?? this.eventBus });
    } else {
      const storage = new InMemoryStorage();
      this.fallbackSessionManager = new SessionManager(storage);
    }

    if (config.skills && config.skills.length > 0) {
      this.skillManager = new SkillManager(config.skills as any[]);
    }

    if (config.handoff) {
      this.handoffManager = new HandoffManager(config.handoff);
    }

    const initTasks: Promise<void>[] = [];
    if (config.webhooks) {
      initTasks.push(
        import("../webhooks/webhook-manager.js").then(({ WebhookManager: WM }) => {
          this.webhookManager = new WM(config.webhooks!);
          this.webhookManager.attach(this.eventBus);
        }),
      );
    }
    if (config.semanticCache) {
      initTasks.push(
        import("../cache/semantic-cache.js").then(({ SemanticCache: SC }) => {
          this.semanticCache = new SC(config.semanticCache!);
        }),
      );
    }
    this.readyPromise = Promise.all(initTasks).then(() => {});

    this.logger = new Logger({
      level: config.logLevel ?? "silent",
      prefix: config.name,
    });

    const allTools = this.collectTools(config);

    this._toolExecutor = allTools.length > 0 ? new ToolExecutor(allTools, this.buildToolExecutorConfig()) : null;

    this.llmLoop = new LLMLoop(config.model, this._toolExecutor, {
      maxToolRoundtrips: config.maxToolRoundtrips ?? 10,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      structuredOutput: config.structuredOutput,
      logger: this.logger,
      reasoning: config.reasoning,
      retry: config.retry,
      toolResultLimit: config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
    });

    if (config.compressionManager) {
      this.compressionManager = config.compressionManager;
      this.compressionManager.setFallbackModel(config.model);
    } else if (config.compressToolResults) {
      this.compressionManager = new CompressionManager({});
      this.compressionManager.setFallbackModel(config.model);
    }

    if (config.toolRouter) {
      this.toolRouter = new ToolRouter({
        ...config.toolRouter,
        logger: config.toolRouter.logger ?? this.logger,
      });
    }

    if (config.culture) {
      this.cultureManager = new CultureManager({
        storage: config.culture.storage,
        model: config.culture.model ?? config.model,
      });
    }

    if (config.register !== false) {
      registry.add(this);
    }
  }

  /**
   * Build a per-request ToolExecutor + LLMLoop, optionally routing tools.
   * Returns a local LLMLoop scoped to this single run/stream call,
   * avoiding shared-state mutation during concurrent requests.
   */
  private async buildRunLoop(query: string, ctx?: RunContext): Promise<LLMLoop> {
    let tools = this.collectTools(this.config);

    // Dynamic tool resolver — merge context-dependent tools
    if (this.config.toolResolver && ctx) {
      const dynamicTools = await this.config.toolResolver(ctx);
      if (dynamicTools.length > 0) {
        const existingNames = new Set(tools.map((t) => t.name));
        tools = [...tools, ...dynamicTools.filter((t) => !existingNames.has(t.name))];
      }
    }

    const totalToolsBefore = tools.length;
    const schemaSize = tools.reduce((sum, t) => sum + JSON.stringify(t.rawJsonSchema ?? {}).length, 0);
    this.logger.debug(
      `buildRunLoop: ${totalToolsBefore} tools, total schema size: ${schemaSize} chars (~${countTokens(JSON.stringify(tools.map((t) => t.rawJsonSchema ?? {})))} tokens)`,
    );

    if (this.toolRouter && tools.length > 0) {
      tools = await this.toolRouter.select(query, tools);
    }

    const finalSchemaSize = tools.reduce((sum, t) => sum + JSON.stringify(t.rawJsonSchema ?? {}).length, 0);
    this.logger.debug(
      `buildRunLoop: after routing: ${tools.length} tools, schema size: ${finalSchemaSize} chars (~${countTokens(JSON.stringify(tools.map((t) => t.rawJsonSchema ?? {})))} tokens)`,
    );

    const executor = tools.length > 0 ? new ToolExecutor(tools, this.buildToolExecutorConfig()) : null;

    return new LLMLoop(this.config.model, executor, {
      maxToolRoundtrips: this.config.maxToolRoundtrips ?? 10,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      structuredOutput: this.config.structuredOutput,
      logger: this.logger,
      reasoning: this.config.reasoning,
      retry: this.config.retry,
      toolResultLimit: this.config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
    });
  }

  toJSON(): SerializedAgent {
    return serializeAgentConfig(this.config);
  }

  static fromJSON(data: SerializedAgent, registry: DeserializeRegistry): Agent {
    const config = buildAgentConfigFromSerialized(data, registry);
    return new Agent(config);
  }

  async close(): Promise<void> {
    if (this.webhookManager) {
      this.webhookManager.detach(this.eventBus);
    }
    if (this.config.memory?.storage) {
      const storage = this.config.memory.storage;
      if (typeof (storage as any).close === "function") {
        await (storage as any).close();
      }
    }
  }

  private async ensureSkillsLoaded(): Promise<void> {
    if (!this.skillManager) return;
    if (!this.skillsInitPromise) {
      this.skillsInitPromise = this.loadSkills();
    }
    await this.skillsInitPromise;
  }

  private async loadSkills(): Promise<void> {
    const skillTools = await this.skillManager!.getTools();
    if (skillTools.length > 0) {
      this.config.tools = [...(this.config.tools ?? []), ...skillTools];
      this.rebuildLLMLoop();
    }
  }

  async run(input: MessageContent, opts?: RunOpts): Promise<RunOutput> {
    await this.readyPromise;
    const startTime = Date.now();
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? uuidv4();
    const userId = opts?.userId ?? this.config.userId;
    const inputText = typeof input === "string" ? input : getTextContent(input);

    await this.ensureSkillsLoaded();

    // Resolve dependencies
    let resolvedDeps: Record<string, string> = {};
    const mergedDeps = { ...(this.config.dependencies ?? {}), ...(opts?.dependencies ?? {}) };
    if (Object.keys(mergedDeps).length > 0) {
      resolvedDeps = await resolveDependencies(mergedDeps);
    }

    // Semantic cache check
    if (this.semanticCache) {
      const hit = await this.semanticCache.lookup(inputText, this.name, sessionId);
      if (hit) {
        this.eventBus.emit("cache.hit", {
          agentName: this.name,
          input: inputText,
          cachedId: hit.id,
        });
        const cachedOutput: RunOutput = {
          ...hit.output,
          durationMs: Date.now() - startTime,
        };
        if (this.config.guardrails?.output) {
          let guardrailFailed = false;
          const ctx = new RunContext({
            sessionId,
            userId,
            metadata: { ...opts?.metadata, agentName: this.name },
            eventBus: this.eventBus,
            sessionState: {},
          });
          for (const guardrail of this.config.guardrails.output) {
            const result = await guardrail.validate(cachedOutput, ctx);
            if (!result.pass) {
              guardrailFailed = true;
              break;
            }
          }
          if (guardrailFailed) {
            this.semanticCache?.invalidate(inputText, this.name).catch(() => {});
          } else {
            return cachedOutput;
          }
        } else {
          return cachedOutput;
        }
      }
      this.eventBus.emit("cache.miss", {
        agentName: this.name,
        input: inputText,
      });
    }

    let session: Session;
    if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      session = await this.memoryManager.getOrCreateSession(sessionId, userId);
    } else {
      session = await this.fallbackSessionManager!.getOrCreate(sessionId, userId);
    }

    const ctx = new RunContext({
      sessionId,
      userId,
      metadata: { ...opts?.metadata, agentName: this.name },
      eventBus: this.eventBus,
      sessionState: { ...session.state },
      signal: opts?.signal,
      dependencies: resolvedDeps,
    });

    this.logger.agentStart(this.name, inputText);

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: this.name,
      input: inputText,
    });

    try {
      if (opts?.signal?.aborted) throw new RunCancelledError();

      if (this.config.hooks?.beforeRun) {
        await this.config.hooks.beforeRun(ctx);
      }

      if (this.config.guardrails?.input) {
        for (const guardrail of this.config.guardrails.input) {
          const result = await guardrail.validate(input, ctx);
          if (!result.pass) {
            throw new Error(`Input guardrail "${guardrail.name}" blocked: ${result.reason}`);
          }
        }
      }

      // Cost budget check before LLM call
      if (this.config.costTracker) {
        this.config.costTracker.checkBudget(ctx.runId, sessionId, userId);
      }

      // Reset compression state for this run
      if (this.compressionManager) this.compressionManager.reset();

      const runLoop = await this.buildRunLoop(inputText, ctx);

      // Apply dependency templates to input
      let processedInput = input;
      if (Object.keys(resolvedDeps).length > 0 && typeof input === "string") {
        processedInput = applyTemplates(input, resolvedDeps);
      }

      const messages = await this.buildMessages(processedInput, session, ctx, inputText);
      const output = await runLoop.run(messages, ctx, opts?.apiKey);

      // Reflection: LLM-as-critic pass over the output, with bounded revision.
      if (this.reflectionManager) {
        const maxReflections = this.config.reflection?.maxReflections ?? 1;
        let critique = await this.reflectionManager.critiqueOutput(output, inputText, messages);
        this.eventBus.emit("reflection.critique", {
          runId: ctx.runId,
          pass: critique.pass,
          score: critique.score,
          feedback: critique.feedback,
        });

        let revisions = 0;
        while (!critique.pass && revisions < maxReflections) {
          revisions++;
          const revisionMessages: ChatMessage[] = [
            ...messages,
            { role: "assistant", content: output.text },
            {
              role: "user",
              content: `A quality reviewer critiqued your previous response:\n${critique.feedback}\n\nProvide an improved response that addresses the critique. Respond with the full corrected answer.`,
            },
          ];
          const revised = await runLoop.run(revisionMessages, ctx, opts?.apiKey);

          output.text = revised.text;
          if (revised.structured !== undefined) output.structured = revised.structured;
          output.toolCalls = [...output.toolCalls, ...revised.toolCalls];
          output.usage = {
            ...output.usage,
            promptTokens: output.usage.promptTokens + revised.usage.promptTokens,
            completionTokens: output.usage.completionTokens + revised.usage.completionTokens,
            totalTokens: output.usage.totalTokens + revised.usage.totalTokens,
          };

          critique = await this.reflectionManager.critiqueOutput(output, inputText, messages);
          this.eventBus.emit("reflection.critique", {
            runId: ctx.runId,
            pass: critique.pass,
            score: critique.score,
            feedback: critique.feedback,
          });
        }

        output.critique = {
          pass: critique.pass,
          score: critique.score,
          feedback: critique.feedback,
          revisions,
        };
      }

      const durationMs = Date.now() - startTime;
      output.durationMs = durationMs;
      output.runId = ctx.runId;
      output.agentName = this.name;
      output.sessionId = sessionId;
      output.userId = userId;
      output.model = this.config.model.modelId;
      output.modelProvider = this.config.model.providerId;
      output.status = output.status ?? "completed";
      output.createdAt = startTime;
      output.messages = messages;
      output.metrics = this.buildMetrics(output, durationMs);

      // Cost tracking after LLM call
      if (this.config.costTracker) {
        this.config.costTracker.track({
          runId: ctx.runId,
          agentName: this.name,
          modelId: this.config.model.modelId,
          usage: output.usage,
          sessionId,
          userId,
        });
        this.eventBus.emit("cost.tracked", {
          runId: ctx.runId,
          agentName: this.name,
          modelId: this.config.model.modelId,
          usage: output.usage,
        });
      }

      // Generate followup suggestions
      if (this.config.generateFollowups) {
        output.followupSuggestions = await this.generateFollowups(output, messages);
      }

      if (this.config.guardrails?.output) {
        for (const guardrail of this.config.guardrails.output) {
          const result = await guardrail.validate(output, ctx);
          if (!result.pass) {
            throw new Error(`Output guardrail "${guardrail.name}" blocked: ${result.reason}`);
          }
        }
      }

      const newMessages: ChatMessage[] = [
        { role: "user", content: inputText },
        { role: "assistant", content: output.text },
      ];

      if (this.memoryManager) {
        await this.memoryManager.appendMessages(sessionId, newMessages, this.config.model);
        await this.memoryManager.updateState(sessionId, ctx.sessionState);

        // Pass the LAST 6 turns (history tail + current exchange) so the
        // extractor can resolve referents like "that one" or "today".
        const tail = messages.slice(-4).filter((m) => m.role === "user" || m.role === "assistant");
        const extractionWindow: ChatMessage[] = [...tail, ...newMessages];
        this.memoryManager.afterRun(sessionId, userId, extractionWindow, this.config.model, this.name);

        this.eventBus.emit("memory.extract", { sessionId, userId, agentName: this.name });
      } else {
        await this.fallbackSessionManager!.appendMessages(sessionId, newMessages);
        await this.fallbackSessionManager!.updateState(sessionId, ctx.sessionState);
      }

      if (this.config.hooks?.afterRun) {
        await this.config.hooks.afterRun(ctx, output);
      }

      // Culture auto-update (fire-and-forget)
      if (this.cultureManager && this.config.culture?.autoUpdate) {
        this.cultureManager.reflect(inputText, output.text).catch(() => {});
      }

      if (output.thinking) {
        this.logger.thinking(output.thinking);
      }
      this.logger.agentEnd(this.name, output.text, output.usage, output.durationMs);

      this.eventBus.emit("run.complete", {
        runId: ctx.runId,
        output,
      });

      // Semantic cache store (fire-and-forget)
      if (this.semanticCache) {
        this.semanticCache
          .store(inputText, output, this.name, sessionId)
          .catch(
            (err) =>
              this.logger?.warn?.(`Cache store failed: ${err?.message}`) ??
              console.warn(`Cache store failed: ${err?.message}`),
          );
      }

      return output;
    } catch (error) {
      // Handle cancellation
      if (error instanceof RunCancelledError) {
        this.eventBus.emit("run.cancelled", { runId: ctx.runId, agentName: this.name });
        const cancelledOutput: RunOutput = {
          text: "",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          status: "cancelled",
          runId: ctx.runId,
          agentName: this.name,
          sessionId,
          userId,
          durationMs: Date.now() - startTime,
        };
        return cancelledOutput;
      }

      // Handle handoff signals
      if (error instanceof HandoffSignal && this.handoffManager) {
        const messages = await this.buildMessages(input, session, ctx, inputText);
        return this.handoffManager.execute(error, this.name, inputText, messages, ctx, this.eventBus, opts);
      }

      const err = error instanceof Error ? error : new Error(String(error));

      this.logger.error(`Run failed: ${err.message}`);

      if (this.config.hooks?.onError) {
        await this.config.hooks.onError(ctx, err);
      }

      this.eventBus.emit("run.error", {
        runId: ctx.runId,
        error: err,
      });

      throw err;
    }
  }

  async *stream(input: MessageContent, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    await this.readyPromise;
    const streamStartTime = Date.now();
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? uuidv4();
    const userId = opts?.userId ?? this.config.userId;
    const inputText = typeof input === "string" ? input : getTextContent(input);

    await this.ensureSkillsLoaded();

    // Semantic cache check for streaming
    if (this.semanticCache) {
      const hit = await this.semanticCache.lookup(inputText, this.name, sessionId);
      if (hit) {
        this.eventBus.emit("cache.hit", {
          agentName: this.name,
          input: inputText,
          cachedId: hit.id,
        });
        yield { type: "text", text: hit.output.text };
        yield { type: "finish", finishReason: "stop", usage: hit.output.usage };
        return;
      }
      this.eventBus.emit("cache.miss", {
        agentName: this.name,
        input: inputText,
      });
    }

    let session: Session;
    if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      session = await this.memoryManager.getOrCreateSession(sessionId, userId);
    } else {
      session = await this.fallbackSessionManager!.getOrCreate(sessionId, userId);
    }

    const ctx = new RunContext({
      sessionId,
      userId,
      metadata: { ...opts?.metadata, agentName: this.name },
      eventBus: this.eventBus,
      sessionState: { ...session.state },
    });

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: this.name,
      input: inputText,
    });

    let fullText = "";
    let streamOk = false;
    let timeToFirstTokenMs: number | undefined;
    let streamMessages: ChatMessage[] | undefined;
    let streamUsage: import("../models/types.js").TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      if (this.config.hooks?.beforeRun) {
        await this.config.hooks.beforeRun(ctx);
      }

      if (this.config.guardrails?.input) {
        for (const guardrail of this.config.guardrails.input) {
          const result = await guardrail.validate(input, ctx);
          if (!result.pass) {
            throw new Error(`Input guardrail "${guardrail.name}" blocked: ${result.reason}`);
          }
        }
      }

      // Cost budget check
      if (this.config.costTracker) {
        this.config.costTracker.checkBudget(ctx.runId, sessionId, userId);
      }

      const runLoop = await this.buildRunLoop(inputText, ctx);

      const messages = await this.buildMessages(input, session, ctx, inputText);
      streamMessages = messages;

      for await (const chunk of runLoop.stream(messages, ctx, opts?.apiKey)) {
        if (chunk.type === "text") {
          if (timeToFirstTokenMs === undefined) {
            timeToFirstTokenMs = Date.now() - streamStartTime;
          }
          fullText += chunk.text;
        } else if (chunk.type === "finish" && chunk.usage) {
          streamUsage = {
            promptTokens: streamUsage.promptTokens + chunk.usage.promptTokens,
            completionTokens: streamUsage.completionTokens + chunk.usage.completionTokens,
            totalTokens: streamUsage.totalTokens + chunk.usage.totalTokens,
            ...(chunk.usage.reasoningTokens
              ? { reasoningTokens: (streamUsage.reasoningTokens ?? 0) + chunk.usage.reasoningTokens }
              : {}),
          };
        }
        yield chunk;
      }

      streamOk = true;
    } catch (error) {
      if (this.handoffManager && error instanceof HandoffSignal) {
        this.eventBus.emit("run.error", {
          runId: ctx.runId,
          error: new Error(`Handoff requested to ${error.targetAgent} but not supported in stream mode`),
        });
        throw new Error(
          `Agent handoff to "${error.targetAgent}" is not supported in stream(). Use run() for handoff-capable agents.`,
        );
      }

      const err = error instanceof Error ? error : new Error(String(error));

      if (this.config.hooks?.onError) {
        await this.config.hooks.onError(ctx, err);
      }

      this.eventBus.emit("run.error", {
        runId: ctx.runId,
        error: err,
      });

      throw err;
    } finally {
      if (streamOk) {
        const durationMs = Date.now() - streamStartTime;

        // Cost tracking
        if (this.config.costTracker) {
          this.config.costTracker.track({
            runId: ctx.runId,
            agentName: this.name,
            modelId: this.config.model.modelId,
            usage: streamUsage,
            sessionId,
            userId,
          });
        }

        const newMessages: ChatMessage[] = [
          { role: "user", content: inputText },
          { role: "assistant", content: fullText },
        ];

        if (this.memoryManager) {
          await this.memoryManager.appendMessages(sessionId, newMessages, this.config.model);
          await this.memoryManager.updateState(sessionId, ctx.sessionState);

          // Same as run(): give the extractor a window of recent turns.
          const tail = (streamMessages ?? []).slice(-4).filter((m) => m.role === "user" || m.role === "assistant");
          const extractionWindow: ChatMessage[] = [...tail, ...newMessages];
          this.memoryManager.afterRun(sessionId, userId, extractionWindow, this.config.model, this.name);
        } else {
          await this.fallbackSessionManager!.appendMessages(sessionId, newMessages);
          await this.fallbackSessionManager!.updateState(sessionId, ctx.sessionState);
        }

        const streamOutput: RunOutput = {
          text: fullText,
          toolCalls: [],
          usage: streamUsage,
          durationMs,
          runId: ctx.runId,
          agentName: this.name,
          sessionId,
          userId,
          model: this.config.model.modelId,
          modelProvider: this.config.model.providerId,
          status: "completed",
          createdAt: streamStartTime,
          messages: streamMessages,
          metrics: {
            inputTokens: streamUsage.promptTokens,
            outputTokens: streamUsage.completionTokens,
            totalTokens: streamUsage.totalTokens,
            ...(streamUsage.reasoningTokens ? { reasoningTokens: streamUsage.reasoningTokens } : {}),
            ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
            durationMs,
          },
        };

        this.eventBus.emit("run.complete", {
          runId: ctx.runId,
          output: streamOutput,
        });

        // Semantic cache store (fire-and-forget)
        if (this.semanticCache) {
          this.semanticCache
            .store(inputText, { text: fullText, toolCalls: [], usage: streamUsage }, this.name, sessionId)
            .catch(
              (err) =>
                this.logger?.warn?.(`Cache store failed: ${err?.message}`) ??
                console.warn(`Cache store failed: ${err?.message}`),
            );
        }
      }
    }
  }

  private async buildMessages(
    input: MessageContent,
    session: Session,
    ctx: RunContext,
    inputText: string,
  ): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];

    let systemContent = "";
    if (this.config.instructions) {
      systemContent =
        typeof this.config.instructions === "function" ? this.config.instructions(ctx) : this.config.instructions;
    }

    // Apply dependency templates to instructions
    if (Object.keys(ctx.dependencies).length > 0 && systemContent) {
      systemContent = applyTemplates(systemContent, ctx.dependencies);
    }

    if (this.memoryManager) {
      const memoryContext = await this.memoryManager.buildContext(session.sessionId, ctx.userId, inputText, this.name);
      if (memoryContext) {
        systemContent = systemContent ? `${systemContent}\n\n${memoryContext}` : memoryContext;
      }
    }

    if (this.skillManager) {
      const skillInstructions = await this.skillManager.getInstructions();
      if (skillInstructions) {
        systemContent = systemContent ? `${systemContent}\n\n${skillInstructions}` : skillInstructions;
      }
    }

    if (this.cultureManager && this.config.culture?.addToContext) {
      const cultureContext = await this.cultureManager.buildContext();
      if (cultureContext) {
        systemContent = systemContent ? `${systemContent}\n\n${cultureContext}` : cultureContext;
      }
    }

    this.logger.debug(
      `buildMessages: system content size: ${systemContent.length} chars (~${countTokens(systemContent)} tokens)`,
    );

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    const maxMessages = this.memoryManager?.getMaxMessages() ?? 20;
    let history = session.messages ?? [];
    if (maxMessages > 0 && history.length > maxMessages) {
      history = history.slice(-maxMessages);
    }

    const maxTokens = this.memoryManager?.getMaxTokens();
    if (maxTokens) {
      history = this.trimHistoryByTokens(history, systemContent, input, maxTokens);
    }

    const historySize = history.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 100), 0);
    this.logger.debug(
      `buildMessages: ${history.length} history msgs, size: ${historySize} chars (~${countTokens(history.map((m) => (typeof m.content === "string" ? m.content : "")).join(""))} tokens)`,
    );

    if (history.length > 0) {
      this.logger.info(`Loaded ${history.length} history messages for session ${session.sessionId}`);
    }
    messages.push(...history);

    const inputSize = typeof input === "string" ? input.length : 100;
    this.logger.debug(
      `buildMessages: user input size: ${inputSize} chars (~${countTokens(typeof input === "string" ? input : "")} tokens)`,
    );
    messages.push({ role: "user", content: input });

    const totalChars = systemContent.length + historySize + inputSize;
    this.logger.debug(
      `buildMessages: TOTAL message content: ${totalChars} chars (~${countTokens(messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(""))} tokens), ${messages.length} messages`,
    );

    this.logger.info(`Sending ${messages.length} messages to LLM`);

    return messages;
  }

  private collectTools(config: AgentConfig): import("../tools/types.js").ToolDef[] {
    const tools = [...(config.tools ?? [])];

    if (this.memoryManager) {
      tools.push(...this.memoryManager.getTools());
    }

    if (config.handoff && config.handoff.targets.length > 0) {
      tools.push(createHandoffTool(config.handoff.targets));
    }

    if (config.artifacts?.enabled) {
      tools.push(...createArtifactTools());
    }

    return tools;
  }

  private buildMetrics(output: RunOutput, durationMs: number): RunMetrics {
    return {
      inputTokens: output.usage.promptTokens,
      outputTokens: output.usage.completionTokens,
      totalTokens: output.usage.totalTokens,
      ...(output.usage.reasoningTokens ? { reasoningTokens: output.usage.reasoningTokens } : {}),
      ...(output.usage.cachedTokens ? { cachedTokens: output.usage.cachedTokens } : {}),
      ...(output.usage.audioInputTokens ? { audioInputTokens: output.usage.audioInputTokens } : {}),
      ...(output.usage.audioOutputTokens ? { audioOutputTokens: output.usage.audioOutputTokens } : {}),
      ...((output as any).timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: (output as any).timeToFirstTokenMs }
        : {}),
      durationMs,
    };
  }

  private async generateFollowups(output: RunOutput, messages: ChatMessage[]): Promise<string[]> {
    const followupConfig = this.config.generateFollowups;
    const count = typeof followupConfig === "object" ? (followupConfig.count ?? 3) : 3;
    const model = typeof followupConfig === "object" && followupConfig.model ? followupConfig.model : this.config.model;

    try {
      const followupMessages: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: output.text },
        {
          role: "user",
          content: `Based on this conversation, suggest exactly ${count} brief followup questions the user might want to ask next. Return ONLY a JSON array of strings, no other text.`,
        },
      ];

      const response = await model.generate(followupMessages, { maxTokens: 512, temperature: 0.7 });
      const text = getTextContent(response.message.content);
      if (!text) return [];

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) return parsed.filter((s: unknown) => typeof s === "string").slice(0, count);
      }
    } catch {
      // followup generation is best-effort
    }
    return [];
  }

  private trimHistoryByTokens(
    history: ChatMessage[],
    systemContent: string,
    currentInput: MessageContent,
    maxTokens: number,
  ): ChatMessage[] {
    const modelId = this.config.model?.modelId;
    const inputText = typeof currentInput === "string" ? currentInput : "(multimodal)";
    const reservedTokens = countTokens(systemContent, modelId) + countTokens(inputText, modelId) + 100;

    const available = maxTokens - reservedTokens;
    if (available <= 0) return [];

    const result: ChatMessage[] = [];
    let used = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const text = typeof msg.content === "string" ? msg.content : "";
      const tokens = countTokens(text, modelId);
      if (used + tokens > available) break;
      used += tokens;
      result.unshift(msg);
    }

    return result;
  }
}
