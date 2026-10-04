import { randomUUID as uuidv4 } from "node:crypto";
import { z } from "zod/v3";
import type { SemanticCache } from "../cache/semantic-cache.js";
import { CheckpointManager } from "../checkpoint/checkpoint-manager.js";
import { CompressionManager } from "../compression/compression-manager.js";
import { ContextCompactor, countConversationTokens, groupConversationTurns } from "../context/context-compactor.js";
import { formatContextFiles, loadContextFiles } from "../context/context-files.js";
import { retainRecentTurns } from "../context/conversation-history.js";
import { applyTemplates, resolveDependencies } from "../dependencies/resolver.js";
import { EventBus } from "../events/event-bus.js";
import { AgentFileSystem } from "../fs/agent-fs.js";
import { getHandoffControl, getHandoffScope, setHandoffControl } from "../handoff/control.js";
import { HandoffManager, settledHandoffPrefix } from "../handoff/handoff-manager.js";
import { createHandoffTool } from "../handoff/handoff-tool.js";
import type { HandoffResult } from "../handoff/types.js";
import { Logger } from "../logger/logger.js";
import { FileMemory } from "../memory/file-memory.js";
import type { UnifiedMemoryConfig } from "../memory/memory-config.js";
import { MemoryManager } from "../memory/memory-manager.js";
import type { ModelProvider } from "../models/provider.js";
import { type ChatMessage, getTextContent, type MessageContent, type StreamChunk } from "../models/types.js";
import { registry } from "../serve.js";
import { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/types.js";
import { SkillManager } from "../skills/skill-manager.js";
import { SkillMdManager } from "../skills/skill-md.js";
import { createArtifactTools } from "../state/artifact-tools.js";
import { InMemoryStorage } from "../storage/in-memory.js";
import { FileSystemToolkit } from "../toolkits/filesystem.js";
import { ApprovalManager } from "../tools/approval.js";
import { defineTool } from "../tools/define-tool.js";
import { evaluateExecutionPolicy } from "../tools/execution-policy.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { ToolRouter } from "../tools/tool-router.js";
import type { ToolDef } from "../tools/types.js";
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
import { createTaskTool, type SubagentSpec, spawnSubagent } from "./subagent.js";
import type { AgentConfig, LoopHooks, RunMetrics, RunOpts, RunOutput } from "./types.js";

const policyComponents = new WeakMap<
  import("../tools/execution-policy.js").ExecutionPolicy,
  readonly import("../tools/execution-policy.js").ExecutionPolicy[]
>();

export class Agent {
  readonly kind = "agent" as const;
  readonly name: string;
  readonly eventBus: EventBus;
  readonly instructions?: string | ((ctx: RunContext) => string);

  private config: AgentConfig;
  private checkpointService: CheckpointManager | null = null;
  private memoryManager: MemoryManager | null = null;
  private skillManager: SkillManager | null = null;
  private skillMd: SkillMdManager | null = null;
  private fileMemory: FileMemory | null = null;
  private agentFs: AgentFileSystem | null = null;
  private workspaceToolkit: FileSystemToolkit | null = null;
  private taskTool: ToolDef | null = null;
  private contextFilesPrompt: string | undefined;
  private handoffManager: HandoffManager | null = null;
  private webhookManager: WebhookManager | null = null;
  private semanticCache: SemanticCache | null = null;
  private compressionManager: CompressionManager | null = null;
  private reflectionManager: ReflectionManager | null = null;
  private fallbackSessionManager: SessionManager | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: assigned in rebuildLLMLoop, kept for future use
  private llmLoop!: LLMLoop;
  private logger: Logger;
  private readyPromise: Promise<void>;
  private approvalService: ApprovalManager | null = null;
  private ownsApprovalService = false;
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
    return [...new Set(this.collectTools(this.config).map((tool) => tool.name))];
  }

  private effectiveExecutionPolicy(
    ...parents: Array<import("../tools/execution-policy.js").ExecutionPolicy | undefined>
  ): import("../tools/execution-policy.js").ExecutionPolicy | undefined {
    const policies = [
      ...new Set(
        [this.config.executionPolicy, ...parents].flatMap((policy) =>
          policy ? (policyComponents.get(policy) ?? [policy]) : [],
        ),
      ),
    ];
    if (policies.length <= 1) return policies[0];
    const combined: import("../tools/execution-policy.js").ExecutionPolicy = {
      decide: async (call, ctx) => {
        let result: import("../tools/execution-policy.js").ExecutionDecision = { action: "allow" };
        for (const policy of policies) {
          const decision = await evaluateExecutionPolicy(policy, call, ctx);
          if (decision.action === "deny") return decision;
          if (decision.action === "ask") result = decision;
        }
        return result;
      },
      resolveEffect: async (call, ctx) => {
        const effects = await Promise.all(policies.map((policy) => policy.resolveEffect?.(call, ctx) ?? "unknown"));
        return (
          effects.find((effect) => effect !== "read" && effect !== "unknown") ??
          (effects.every((effect) => effect === "read") ? "read" : "unknown")
        );
      },
    };
    policyComponents.set(combined, policies);
    return combined;
  }

  private validateControlledRun(opts?: RunOpts): void {
    if (opts && Object.hasOwn(opts, "harnessServices"))
      throw new Error("RunOpts.harnessServices was removed; use the host-supplied executionServices port");
    if (!opts?.executionServices) return;
    if (this.handoffManager)
      throw new Error("Agent handoff cannot run inside supplied execution services; use host-owned delegation");
    if (this.reflectionManager) throw new Error("Agent reflection must be owned by the supplied execution boundary");
    if (this.config.toolResultLimit?.strategy === "summarize" && this.config.toolResultLimit.model)
      throw new Error("Model-backed tool-result summarization must be owned by the supplied execution boundary");
    if (this.compressionManager || this.config.contextCompactor?.summarizeModel)
      throw new Error("Model-backed Agent compression must be owned by the supplied execution boundary");
  }

  private normalizeControlledRun(opts?: RunOpts): RunOpts | undefined {
    const services = opts?.executionServices;
    if (!services) return opts;
    const parent = services.ctx;
    for (const key of ["userId", "tenantId"] as const) {
      if (opts[key] !== undefined && opts[key] !== parent[key])
        throw new Error(`Execution services ${key} cannot be overridden`);
    }
    const runMode = opts.runMode ?? parent.runMode;
    if (!["plan", "execute"].includes(runMode) || (parent.runMode === "plan" && runMode !== "plan"))
      throw new Error("Execution services runMode cannot be weakened");
    const signal =
      opts.signal && opts.signal !== services.signal
        ? AbortSignal.any([services.signal, opts.signal])
        : services.signal;
    signal.throwIfAborted();
    // Delegated calls retain their own run/session/history. Port-only root calls
    // inherit the owner's canonical state instead of silently creating a new scope.
    const root =
      opts.runId === parent.runId ||
      (opts.runId === undefined &&
        opts.metadata?.parentRunId === undefined &&
        (opts.sessionId === undefined ||
          opts.sessionId === services.sessionKey ||
          opts.sessionId === parent.sessionId));
    return {
      ...opts,
      userId: parent.userId,
      tenantId: parent.tenantId,
      sessionId: opts.sessionId ?? services.sessionKey,
      runId: opts.runId ?? (root ? parent.runId : undefined),
      history: opts.history ?? (root ? services.history : undefined),
      metadata: { ...parent.metadata, ...opts.metadata },
      runMode,
      signal,
    };
  }

  private buildToolExecutorConfig(
    ctx?: RunContext,
    opts?: RunOpts,
  ): import("../tools/tool-executor.js").ToolExecutorConfig {
    return {
      sandbox: this.config.sandbox,
      approvalManager: ctx?.executionServices?.approvalManager ?? this.approvalService ?? undefined,
      // Supplied orchestration may add approvals, but cannot replace the Agent's own gate.
      // ToolExecutor deduplicates managers by identity when the host shares one instance.
      additionalApprovalManagers: [
        ...(this.approvalService ? [this.approvalService] : []),
        ...(getHandoffScope(opts)?.approvals ?? []),
      ],
      executionPolicy: ctx?.executionPolicy ?? this.config.executionPolicy,
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
      providerOptions: this.config.providerOptions,
      retry: this.config.retry,
      toolResultLimit: this.config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
      checkpointManager: this.checkpointService ?? undefined,
    });
  }

  get model(): ModelProvider {
    return this.config.model;
  }

  /** Alias for `eventBus`. */
  get events(): EventBus {
    return this.eventBus;
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
    return this.approvalService;
  }

  get structuredOutputSchema(): import("../tools/schema.js").AgentiumSchema | undefined {
    return this.config.structuredOutput;
  }

  /** Access the MemoryManager (if memory is configured). */
  get memory(): MemoryManager | null {
    return this.memoryManager;
  }

  /** Access the CheckpointManager (if checkpointing is configured). */
  get checkpointManager() {
    return this.checkpointService;
  }

  constructor(config: AgentConfig) {
    for (const key of ["harness", "harnessOptions", "replaceTools"]) {
      if (Object.hasOwn(config, key))
        throw new Error(
          `Agent.${key} was removed; compose configuration and abilities through @agentium/harness and its agent driver`,
        );
    }
    if (
      config.workspace !== undefined &&
      config.workspace !== false &&
      (typeof config.workspace !== "object" ||
        !config.workspace ||
        typeof config.workspace.path !== "string" ||
        !config.workspace.path.trim() ||
        !["read", "write"].includes(config.workspace.mode))
    )
      throw new Error(
        'Agent workspace requires an explicit { path, mode: "read" | "write" }; string workspaces were removed',
      );
    this.config = config;
    this.checkpointService = config.checkpointing
      ? new CheckpointManager(typeof config.checkpointing === "object" ? config.checkpointing.storage : undefined)
      : null;
    this.name = config.name;
    this.instructions = config.instructions;
    this.eventBus = config.eventBus ?? config.events ?? (config.sharedEventBus ? EventBus.shared : new EventBus());

    if (config.approvalManager) {
      this.approvalService = config.approvalManager;
    } else if (config.approval) {
      this.approvalService = new ApprovalManager({ ...config.approval, eventBus: this.eventBus });
      this.ownsApprovalService = true;
    }

    if (config.reflection?.enabled) {
      this.reflectionManager = new ReflectionManager(config.reflection, config.model);
    }

    const memoryConfig = resolveMemoryConfig(config);
    if (memoryConfig) {
      this.memoryManager = new MemoryManager({ ...memoryConfig, eventBus: memoryConfig.eventBus ?? this.eventBus });
    } else {
      this.fallbackSessionManager = new SessionManager(new InMemoryStorage());
    }

    // Standing notes default to the same storage as memory so they survive a
    // restart whenever the agent has persistent memory configured.
    const sharedStorage = config.memory?.storage;

    if (config.fileMemory) {
      const fileMemoryConfig = config.fileMemory === true ? {} : config.fileMemory;
      this.fileMemory = new FileMemory({
        ...fileMemoryConfig,
        storage: fileMemoryConfig.storage ?? sharedStorage,
      });
    }
    if (config.filesystem) {
      const fsConfig = config.filesystem === true ? {} : config.filesystem;
      this.agentFs = new AgentFileSystem({ ...fsConfig, storage: fsConfig.storage ?? sharedStorage });
    }
    if (config.skillDirs && config.skillDirs.length > 0) {
      this.skillMd = new SkillMdManager({ dirs: config.skillDirs });
    }
    if (config.workspace) {
      const workspace = config.workspace;
      this.workspaceToolkit = new FileSystemToolkit({
        basePath: workspace.path,
        allowWrite: workspace.mode === "write",
      });
    }
    if (config.subagents) {
      const maxDepth = typeof config.subagents === "object" ? config.subagents.maxDepth : undefined;
      this.taskTool = createTaskTool(this, { maxDepth });
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
      providerOptions: config.providerOptions,
      retry: config.retry,
      toolResultLimit: config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
      checkpointManager: this.checkpointService ?? undefined,
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

    if (config.register !== false) {
      registry.add(this);
    }
  }

  /**
   * Build a per-request ToolExecutor + LLMLoop, optionally routing tools.
   * Returns a local LLMLoop scoped to this single run/stream call,
   * avoiding shared-state mutation during concurrent requests.
   */
  private async buildRunLoop(query: string, ctx?: RunContext, opts?: RunOpts): Promise<LLMLoop> {
    let tools = this.collectTools(this.config);

    // Dynamic tool resolver — merge context-dependent tools
    if (this.config.toolResolver && ctx) {
      const dynamicTools = await this.config.toolResolver(ctx);
      if (dynamicTools.length > 0) {
        const existingNames = new Set(tools.map((t) => t.name));
        tools = ctx.executionServices
          ? [...tools, ...dynamicTools]
          : [...tools, ...dynamicTools.filter((t) => !existingNames.has(t.name))];
      }
    }

    if (ctx?.executionServices) {
      tools = [...tools, ...ctx.executionServices.tools];
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
        throw new Error(
          "Duplicate tool name across Agent and supplied execution services; select one owner for each tool",
        );
    }

    const totalToolsBefore = tools.length;
    if (this.toolRouter && tools.length > 0) {
      tools = await this.toolRouter.select(query, tools);
    }
    this.logger.debug("tools", {
      before: totalToolsBefore,
      after: tools.length,
      routed: Boolean(this.toolRouter && totalToolsBefore !== tools.length),
    });

    const executor = tools.length > 0 ? new ToolExecutor(tools, this.buildToolExecutorConfig(ctx, opts)) : null;

    const provider = ctx?.executionServices
      ? {
          providerId: this.config.model.providerId,
          modelId: this.config.model.modelId,
          generate: (
            messages: ChatMessage[],
            options?: import("../models/types.js").ModelConfig & {
              tools?: import("../models/types.js").ToolDefinition[];
            },
          ) => ctx.executionServices!.model(this.config.model, messages, options, ctx),
          stream: (
            messages: ChatMessage[],
            options?: import("../models/types.js").ModelConfig & {
              tools?: import("../models/types.js").ToolDefinition[];
            },
          ) => ctx.executionServices!.streamModel(this.config.model, messages, options, ctx),
        }
      : this.config.model;
    return new LLMLoop(provider, executor, {
      maxToolRoundtrips: this.config.maxToolRoundtrips ?? 10,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      structuredOutput: this.config.structuredOutput,
      logger: this.logger,
      reasoning: this.config.reasoning,
      providerOptions: this.config.providerOptions,
      retry: this.config.retry,
      toolResultLimit: this.config.toolResultLimit,
      loopHooks: this.buildLoopHooks(),
      checkpointManager: this.checkpointService ?? undefined,
      controlledExecution: Boolean(ctx?.executionServices),
    });
  }

  toJSON(): SerializedAgent {
    return serializeAgentConfig(this.config);
  }

  static fromJSON(data: SerializedAgent, registry: DeserializeRegistry): Agent {
    const config = buildAgentConfigFromSerialized(data, registry);
    return new Agent(config);
  }

  async close(options: { closeStorage?: boolean } = {}): Promise<void> {
    if (this.ownsApprovalService) this.approvalService?.close();
    if (this.webhookManager) {
      this.webhookManager.detach(this.eventBus);
    }
    if (options.closeStorage !== false && this.config.memory?.storage) {
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
    opts = this.normalizeControlledRun(opts);
    this.validateControlledRun(opts);
    await this.readyPromise;
    const startTime = Date.now();
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? uuidv4();
    const userId =
      opts?.executionServices || getHandoffScope(opts) ? opts?.userId : (opts?.userId ?? this.config.userId);
    const inputText = typeof input === "string" ? input : getTextContent(input);

    await this.ensureSkillsLoaded();

    // Resolve dependencies
    let resolvedDeps: Record<string, string> = {};
    const mergedDeps = { ...(this.config.dependencies ?? {}), ...(opts?.dependencies ?? {}) };
    if (Object.keys(mergedDeps).length > 0) {
      resolvedDeps = await resolveDependencies(mergedDeps);
    }

    // Semantic cache check
    if (this.semanticCache && !opts?.executionServices && !opts?.ephemeral) {
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
            tenantId: opts?.tenantId,
            signal: opts?.signal,
            runMode: opts?.runMode,
            executionPolicy: this.config.executionPolicy,
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

    const ephemeral = Boolean(opts?.ephemeral || opts?.executionServices);
    let session: Session;
    if (ephemeral) {
      session = {
        sessionId,
        userId,
        messages: [],
        state: { ...opts?.executionServices?.state },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } else if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      session = await this.memoryManager.getOrCreateSession(sessionId, userId);
    } else {
      session = await this.fallbackSessionManager!.getOrCreate(sessionId, userId);
    }

    const ctx = new RunContext({
      sessionId,
      userId,
      tenantId: opts?.tenantId,
      metadata: { ...opts?.metadata, agentName: this.name },
      eventBus: this.eventBus,
      sessionState:
        opts?.executionServices && opts.runId === opts.executionServices.ctx.runId
          ? opts.executionServices.state
          : { ...session.state, ...structuredClone(getHandoffScope(opts)?.state ?? {}) },
      signal: opts?.signal,
      runMode: opts?.runMode,
      executionPolicy: this.effectiveExecutionPolicy(opts?.executionServices?.executionPolicy, opts?.executionPolicy),
      executionServices: opts?.executionServices,
      externalHistory: opts?.history,
      ephemeral,
      runId: opts?.runId,
      dependencies: resolvedDeps,
      questions: opts?.questions,
    });

    this.logger.agentStart(this.name, inputText);

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      ...(typeof ctx.metadata.parentRunId === "string" ? { parentRunId: ctx.metadata.parentRunId } : {}),
      ...(typeof ctx.metadata.rootRunId === "string" ? { rootRunId: ctx.metadata.rootRunId } : {}),
      ...(typeof ctx.metadata.attemptId === "string" ? { attemptId: ctx.metadata.attemptId } : {}),
      agentName: this.name,
      input: inputText,
    });

    const transcript: ChatMessage[] = [];
    let processedInput = input;
    let persistedMessages = 0;
    const persistHandoffTranscript = async () => {
      if (
        ephemeral ||
        persistedMessages ||
        !transcript.some((message) => message.toolCalls?.some((call) => call.name === "transfer_to_agent"))
      )
        return;
      const pending = new Set<string>();
      for (const message of transcript) {
        for (const call of message.toolCalls ?? []) pending.add(call.id);
        if (message.role === "tool" && message.toolCallId) pending.delete(message.toolCallId);
      }
      if (pending.size) return;
      // Failed output guards/hooks must not persist an unvalidated final answer.
      let lastTool = transcript.length - 1;
      while (lastTool >= 0 && transcript[lastTool].role !== "tool") lastTool--;
      const messages: ChatMessage[] = [{ role: "user", content: processedInput }, ...transcript.slice(0, lastTool + 1)];
      const additions = messages.slice(persistedMessages);
      if (!additions.length) return;
      if (this.memoryManager) {
        await this.memoryManager.appendMessages(sessionId, additions, this.config.model);
        persistedMessages = messages.length;
        await this.memoryManager.updateState(sessionId, ctx.sessionState);
      } else {
        await this.fallbackSessionManager!.appendMessages(sessionId, additions);
        persistedMessages = messages.length;
        await this.fallbackSessionManager!.updateState(sessionId, ctx.sessionState);
      }
    };
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

      const runLoop = await this.buildRunLoop(inputText, ctx, opts);

      // Apply dependency templates to input
      if (Object.keys(resolvedDeps).length > 0 && typeof input === "string") {
        processedInput = applyTemplates(input, resolvedDeps);
      }

      const messages = await this.buildMessages(processedInput, session, ctx, inputText);
      ctx.executionServices?.recordConversation(ctx.runId, [{ role: "user", content: processedInput }]);
      const output = await runLoop.run(messages, ctx, opts?.apiKey, transcript);

      // Reflection: LLM-as-critic pass over the output, with bounded revision.
      if (this.reflectionManager && !getHandoffControl(output)) {
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
          const revisionPrompt: ChatMessage = {
            role: "user",
            content: `A quality reviewer critiqued your previous response:\n${critique.feedback}\n\nProvide an improved response that addresses the critique. Respond with the full corrected answer.`,
          };
          const revisionMessages = [...messages, ...transcript, revisionPrompt];
          transcript.push(revisionPrompt);
          ctx.executionServices?.recordConversation(ctx.runId, [revisionPrompt]);
          const revised = await runLoop.run(revisionMessages, ctx, opts?.apiKey, transcript);

          output.text = revised.text;
          if (revised.structured !== undefined) output.structured = revised.structured;
          output.toolCalls = [...output.toolCalls, ...revised.toolCalls];
          output.usage = {
            ...output.usage,
            promptTokens: output.usage.promptTokens + revised.usage.promptTokens,
            completionTokens: output.usage.completionTokens + revised.usage.completionTokens,
            totalTokens: output.usage.totalTokens + revised.usage.totalTokens,
          };
          const transfer = getHandoffControl(revised);
          if (transfer) {
            setHandoffControl(output, transfer);
            break;
          }

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

      const sourceUsage = { ...output.usage };
      // Cost tracking after LLM call
      if (this.config.costTracker) {
        const entry = this.config.costTracker.track({
          runId: ctx.runId,
          agentName: this.name,
          modelId: this.config.model.modelId,
          usage: sourceUsage,
          sessionId,
          userId,
        });
        this.eventBus.emit("cost.tracked", {
          runId: ctx.runId,
          agentName: this.name,
          modelId: this.config.model.modelId,
          usage: sourceUsage,
          cost: entry.cost,
        });
      }

      const transfer = getHandoffControl(output);
      if (transfer) {
        await persistHandoffTranscript();
        if (ctx.signal?.aborted) throw new RunCancelledError();
        if (!this.handoffManager) throw new Error("Handoff requested without configured targets");
        const delegated = await this.handoffManager.execute(
          transfer,
          this.name,
          inputText,
          [...messages, ...transcript],
          ctx,
          this.eventBus,
          opts,
          this.approvalService ? [this.approvalService] : [],
        );
        const calls = [...output.toolCalls, ...delegated.toolCalls];
        Object.assign(output, delegated);
        output.toolCalls = calls;
        output.usage = {
          ...sourceUsage,
          promptTokens: sourceUsage.promptTokens + delegated.usage.promptTokens,
          completionTokens: sourceUsage.completionTokens + delegated.usage.completionTokens,
          totalTokens: sourceUsage.totalTokens + delegated.usage.totalTokens,
        };
        for (const key of ["reasoningTokens", "cachedTokens", "audioInputTokens", "audioOutputTokens"] as const) {
          if (sourceUsage[key] !== undefined || delegated.usage[key] !== undefined)
            output.usage[key] = (sourceUsage[key] ?? 0) + (delegated.usage[key] ?? 0);
        }
        // Target provider envelopes stay in its own session; carry only the final display answer back.
        if (output.text) transcript.push({ role: "assistant", content: output.text });
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
      output.messages = [...messages, ...transcript];
      output.metrics = this.buildMetrics(output, durationMs);

      if (this.config.guardrails?.output) {
        for (const guardrail of this.config.guardrails.output) {
          const result = await guardrail.validate(output, ctx);
          if (!result.pass) {
            throw new Error(`Output guardrail "${guardrail.name}" blocked: ${result.reason}`);
          }
        }
      }

      const newMessages: ChatMessage[] = [{ role: "user", content: processedInput }, ...transcript];
      output.newMessages = structuredClone(newMessages);

      if (!ephemeral && this.memoryManager) {
        await this.memoryManager.appendMessages(sessionId, newMessages.slice(persistedMessages), this.config.model);
        persistedMessages = newMessages.length;
        await this.memoryManager.updateState(sessionId, ctx.sessionState);

        // Pass the LAST 6 turns (history tail + current exchange) so the
        // extractor can resolve referents like "that one" or "today".
        const tail = messages.slice(-4).filter((m) => m.role === "user" || m.role === "assistant");
        const extractionWindow: ChatMessage[] = [...tail, ...newMessages];
        this.memoryManager.afterRun(sessionId, userId, extractionWindow, this.config.model, this.name);

        this.eventBus.emit("memory.extract", { sessionId, userId, agentName: this.name });
      } else if (!ephemeral) {
        await this.fallbackSessionManager!.appendMessages(sessionId, newMessages.slice(persistedMessages));
        persistedMessages = newMessages.length;
        await this.fallbackSessionManager!.updateState(sessionId, ctx.sessionState);
      }

      if (this.config.hooks?.afterRun) {
        await this.config.hooks.afterRun(ctx, output);
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
      if (this.semanticCache && !opts?.executionServices && !opts?.ephemeral) {
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
      // Completed source tool groups survive a failed/cancelled target; never persist a partial batch.
      await persistHandoffTranscript();
      // Handle cancellation
      if (error instanceof RunCancelledError || ctx.signal?.aborted) {
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
    } finally {
      this.approvalService?.cancelRun(ctx.runId);
      for (const manager of getHandoffScope(opts)?.approvals ?? []) manager.cancelRun(ctx.runId);
    }
  }

  async *stream(input: MessageContent, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    opts = this.normalizeControlledRun(opts);
    this.validateControlledRun(opts);
    await this.readyPromise;
    const streamStartTime = Date.now();
    const sessionId = opts?.sessionId ?? this.config.sessionId ?? uuidv4();
    const userId =
      opts?.executionServices || getHandoffScope(opts) ? opts?.userId : (opts?.userId ?? this.config.userId);
    const inputText = typeof input === "string" ? input : getTextContent(input);

    await this.ensureSkillsLoaded();

    // Semantic cache check for streaming
    if (this.semanticCache && !opts?.executionServices && !opts?.ephemeral) {
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

    const ephemeral = Boolean(opts?.ephemeral || opts?.executionServices);
    let session: Session;
    if (ephemeral) {
      session = {
        sessionId,
        userId,
        messages: [],
        state: { ...opts?.executionServices?.state },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } else if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      session = await this.memoryManager.getOrCreateSession(sessionId, userId);
    } else {
      session = await this.fallbackSessionManager!.getOrCreate(sessionId, userId);
    }

    const ctx = new RunContext({
      sessionId,
      userId,
      tenantId: opts?.tenantId,
      metadata: { ...opts?.metadata, agentName: this.name },
      eventBus: this.eventBus,
      sessionState:
        opts?.executionServices && opts.runId === opts.executionServices.ctx.runId
          ? opts.executionServices.state
          : { ...session.state, ...structuredClone(getHandoffScope(opts)?.state ?? {}) },
      signal: opts?.signal,
      runMode: opts?.runMode,
      executionPolicy: this.effectiveExecutionPolicy(opts?.executionServices?.executionPolicy, opts?.executionPolicy),
      executionServices: opts?.executionServices,
      externalHistory: opts?.history,
      ephemeral,
      runId: opts?.runId,
      questions: opts?.questions,
    });

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      ...(typeof ctx.metadata.parentRunId === "string" ? { parentRunId: ctx.metadata.parentRunId } : {}),
      ...(typeof ctx.metadata.rootRunId === "string" ? { rootRunId: ctx.metadata.rootRunId } : {}),
      ...(typeof ctx.metadata.attemptId === "string" ? { attemptId: ctx.metadata.attemptId } : {}),
      agentName: this.name,
      input: inputText,
    });

    const inheritedStream = getHandoffScope(opts)?.stream;
    const transcript = inheritedStream?.transcript ?? [];
    const newMessages = (): ChatMessage[] => [
      ...(inheritedStream?.continuation ? [] : [{ role: "user" as const, content: input }]),
      ...transcript,
    ];
    let fullText = "";
    let completed = false;
    let terminalEmitted = false;
    let persistedMessages = 0;
    let timeToFirstTokenMs: number | undefined;
    let streamMessages: ChatMessage[] = [];
    let delegated: HandoffResult | undefined;
    const streamToolCalls: import("../tools/types.js").ToolCallResult[] = [];
    const streamOutcome: { status: "completed" | "stopped" } = { status: "completed" };
    let streamUsage: import("../models/types.js").TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let sourceUsage: typeof streamUsage | undefined;
    let costTracked = false;
    const recordChunk = (chunk: StreamChunk) => {
      if (chunk.type === "text") {
        timeToFirstTokenMs ??= Date.now() - streamStartTime;
        fullText += chunk.text;
      } else if (chunk.type === "finish" && chunk.usage) {
        const previous = streamUsage;
        streamUsage = {
          promptTokens: previous.promptTokens + chunk.usage.promptTokens,
          completionTokens: previous.completionTokens + chunk.usage.completionTokens,
          totalTokens: previous.totalTokens + chunk.usage.totalTokens,
        };
        for (const key of ["reasoningTokens", "cachedTokens", "audioInputTokens", "audioOutputTokens"] as const)
          if (previous[key] !== undefined || chunk.usage[key] !== undefined)
            streamUsage[key] = (previous[key] ?? 0) + (chunk.usage[key] ?? 0);
      }
    };
    const trackSourceCost = () => {
      if (costTracked || !this.config.costTracker) return;
      costTracked = true;
      const usage = sourceUsage ?? streamUsage;
      const entry = this.config.costTracker.track({
        runId: ctx.runId,
        agentName: this.name,
        modelId: this.config.model.modelId,
        usage,
        sessionId,
        userId,
      });
      this.eventBus.emit("cost.tracked", {
        runId: ctx.runId,
        agentName: this.name,
        modelId: this.config.model.modelId,
        usage,
        cost: entry.cost,
      });
    };
    const persist = async (messages: ChatMessage[]) => {
      if (ephemeral || messages.length <= persistedMessages) return;
      if (this.memoryManager) {
        await this.memoryManager.appendMessages(sessionId, messages.slice(persistedMessages), this.config.model);
        persistedMessages = messages.length;
        await this.memoryManager.updateState(sessionId, ctx.sessionState);
      } else {
        await this.fallbackSessionManager!.appendMessages(sessionId, messages.slice(persistedMessages));
        persistedMessages = messages.length;
        await this.fallbackSessionManager!.updateState(sessionId, ctx.sessionState);
      }
    };
    const persistSettledHandoff = async () => {
      if (!transcript.some((message) => message.toolCalls?.some((call) => call.name === "transfer_to_agent"))) return;
      const prefix = settledHandoffPrefix(transcript);
      if (prefix.length)
        await persist([
          ...(inheritedStream?.continuation ? [] : [{ role: "user" as const, content: input }]),
          ...prefix,
        ]);
    };

    try {
      if (ctx.signal?.aborted) throw new RunCancelledError();
      await this.config.hooks?.beforeRun?.(ctx);
      for (const guardrail of this.config.guardrails?.input ?? []) {
        const result = await guardrail.validate(input, ctx);
        if (!result.pass) throw new Error(`Input guardrail "${guardrail.name}" blocked: ${result.reason}`);
      }
      this.config.costTracker?.checkBudget(ctx.runId, sessionId, userId);
      const runLoop = await this.buildRunLoop(inputText, ctx, opts);
      const messages = await this.buildMessages(input, session, ctx, inputText, !inheritedStream?.continuation);
      streamMessages = messages;
      ctx.executionServices?.recordConversation(ctx.runId, [{ role: "user", content: input }]);
      for await (const chunk of runLoop.stream(
        messages,
        ctx,
        opts?.apiKey,
        transcript,
        streamToolCalls,
        streamOutcome,
      )) {
        recordChunk(chunk);
        yield chunk;
      }
      sourceUsage = { ...streamUsage };
      trackSourceCost();
      const transfer = getHandoffControl(streamOutcome);
      if (transfer) {
        await persistSettledHandoff();
        ctx.signal?.throwIfAborted();
        const manager = this.handoffManager;
        if (!manager) throw new Error("Handoff requested without configured targets");
        const delegatedTranscript: ChatMessage[] = [];
        const continuation = manager.stream(
          transfer,
          this.name,
          inputText,
          [...messages, ...transcript],
          ctx,
          this.eventBus,
          opts,
          this.approvalService ? [this.approvalService] : [],
          delegatedTranscript,
          this.config.model,
        );
        // Capture the generator return without buffering its chunks or weakening iterator return/throw cleanup.
        const forward = async function* () {
          delegated = yield* continuation;
        };
        try {
          for await (const chunk of forward()) {
            recordChunk(chunk);
            yield chunk;
          }
        } finally {
          transcript.push(...delegatedTranscript);
        }
        if (!delegated) throw new Error("Handoff stream ended without a result");
        streamToolCalls.push(...delegated.toolCalls);
        if (delegated.status === "stopped") streamOutcome.status = "stopped";
      }
      ctx.signal?.throwIfAborted();
      const durationMs = Date.now() - streamStartTime;
      const additions = newMessages();
      const streamOutput: RunOutput = {
        text: fullText,
        toolCalls: streamToolCalls,
        usage: streamUsage,
        durationMs,
        runId: ctx.runId,
        agentName: this.name,
        sessionId,
        userId,
        model: this.config.model.modelId,
        modelProvider: this.config.model.providerId,
        status: streamOutcome.status,
        createdAt: streamStartTime,
        messages: [...streamMessages, ...transcript],
        newMessages: structuredClone(additions),
        metrics: {
          inputTokens: streamUsage.promptTokens,
          outputTokens: streamUsage.completionTokens,
          totalTokens: streamUsage.totalTokens,
          ...(streamUsage.reasoningTokens ? { reasoningTokens: streamUsage.reasoningTokens } : {}),
          ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
          durationMs,
        },
      };
      if (delegated)
        Object.assign(streamOutput, { handoffChain: delegated.handoffChain, finalAgent: delegated.finalAgent });
      for (const guardrail of this.config.guardrails?.output ?? []) {
        const result = await guardrail.validate(streamOutput, ctx);
        if (!result.pass) throw new Error(`Output guardrail "${guardrail.name}" blocked: ${result.reason}`);
      }
      ctx.signal?.throwIfAborted();
      await persist(additions);
      if (!ephemeral && this.memoryManager) {
        const tail = streamMessages
          .slice(-4)
          .filter((message) => message.role === "user" || message.role === "assistant");
        this.memoryManager.afterRun(sessionId, userId, [...tail, ...additions], this.config.model, this.name);
      }
      await this.config.hooks?.afterRun?.(ctx, streamOutput);
      ctx.signal?.throwIfAborted();
      inheritedStream?.complete(streamOutput);
      completed = true;
      terminalEmitted = true;
      this.eventBus.emit("run.complete", { runId: ctx.runId, output: streamOutput });
      if (this.semanticCache && !opts?.executionServices && !opts?.ephemeral) {
        this.semanticCache.store(inputText, streamOutput, this.name, sessionId).catch((error: unknown) => {
          this.logger.warn(`Cache store failed: ${error instanceof Error ? error.message : "Unknown error"}`);
        });
      }
    } catch (error) {
      await persistSettledHandoff();
      const err = error instanceof Error ? error : new Error(String(error));
      await this.config.hooks?.onError?.(ctx, err);
      terminalEmitted = true;
      this.eventBus.emit("run.error", {
        runId: ctx.runId,
        error: err,
        status: ctx.signal?.aborted || error instanceof RunCancelledError ? "cancelled" : "failed",
      });
      throw err;
    } finally {
      this.approvalService?.cancelRun(ctx.runId);
      for (const manager of getHandoffScope(opts)?.approvals ?? []) manager.cancelRun(ctx.runId);
      trackSourceCost();
      if (!completed) await persistSettledHandoff();
      if (!terminalEmitted) this.eventBus.emit("run.cancelled", { runId: ctx.runId, agentName: this.name });
    }
  }

  private async buildMessages(
    input: MessageContent,
    session: Session,
    ctx: RunContext,
    inputText: string,
    includeInput = true,
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

    if (this.memoryManager && !ctx.ephemeral) {
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

    if (this.skillMd) {
      const skillIndex = await this.skillMd.getIndexPrompt();
      if (skillIndex) {
        systemContent = systemContent ? `${systemContent}\n\n${skillIndex}` : skillIndex;
      }
    }

    const projectContext = await this.loadContextFilesPrompt();
    if (projectContext) {
      systemContent = systemContent ? `${systemContent}\n\n${projectContext}` : projectContext;
    }

    if (this.fileMemory) {
      const fileMem = await this.fileMemory.getContextString({ userId: ctx.userId, agentName: this.name });
      if (fileMem) {
        systemContent = systemContent ? `${systemContent}\n\n${fileMem}` : fileMem;
      }
    }

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    const maxMessages = this.memoryManager?.getMaxMessages() ?? 20;
    let history = ctx.externalHistory ? [...ctx.externalHistory] : (session.messages ?? []);
    if (maxMessages > 0 && history.length > maxMessages) {
      history = retainRecentTurns(history, maxMessages);
    }

    const maxTokens = this.memoryManager?.getMaxTokens();
    if (maxTokens) {
      history = this.trimHistoryByTokens(history, systemContent, input, maxTokens);
    }

    messages.push(...history);
    if (includeInput) messages.push({ role: "user", content: input });

    this.logger.debug("prompt", {
      systemChars: systemContent.length,
      history: history.length,
      messages: messages.length,
    });

    return messages;
  }

  private collectTools(config: AgentConfig): ToolDef[] {
    const tools = [...(config.tools ?? [])];
    const names = new Set(tools.map((t) => t.name));
    const add = (extra: ToolDef[]) => {
      for (const tool of extra) {
        if (names.has(tool.name)) {
          continue;
        }
        names.add(tool.name);
        tools.push(tool);
      }
    };

    if (this.memoryManager) {
      add(this.memoryManager.getTools());
    }

    if (config.handoff && config.handoff.targets.length > 0) {
      add([createHandoffTool(config.handoff.targets)]);
    }

    if (config.artifacts?.enabled) {
      add(createArtifactTools());
    }

    if (this.fileMemory) add(this.fileMemory.getTools());
    if (this.agentFs) add(this.agentFs.getTools());
    if (this.skillMd) add(this.skillMd.getTools());
    if (this.workspaceToolkit) add(this.workspaceToolkit.getTools());
    if (this.taskTool) add([this.taskTool]);
    if (config.searchPastSessions) add([this.createSearchSessionsTool()]);

    return tools;
  }

  private sessionStore(): SessionManager {
    return this.memoryManager?.sessionManager ?? this.fallbackSessionManager!;
  }

  private createSearchSessionsTool(): ToolDef {
    return defineTool({
      name: "search_past_sessions",
      description:
        "Search older chat sessions by keyword. Use this when the user refers to something from a previous conversation.",
      parameters: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
      execute: async ({ query, limit }, ctx) => {
        const hits = await this.sessionStore().searchSessions(query, { userId: ctx.userId, limit: limit ?? 8 });
        if (hits.length === 0) return "No matching sessions.";
        return hits.map((h) => `[${h.sessionId}] ${h.snippet}`).join("\n");
      },
    });
  }

  private async loadContextFilesPrompt(): Promise<string> {
    if (!this.config.contextFiles) return "";
    if (this.contextFilesPrompt !== undefined) return this.contextFilesPrompt;
    const opts = this.config.contextFiles === true ? {} : this.config.contextFiles;
    const files = await loadContextFiles(opts);
    this.contextFilesPrompt = formatContextFiles(files);
    return this.contextFilesPrompt;
  }

  /** Run a child agent with a fresh message list. Returns the child's final text. */
  async spawnSubagent(task: string, spec?: SubagentSpec, runOpts?: RunOpts): Promise<string> {
    const maxDepth = typeof this.config.subagents === "object" ? this.config.subagents.maxDepth : 2;
    return spawnSubagent({ parent: this, task, spec, runOpts, maxDepth });
  }

  /** Internal child recipe: fresh state and borrowed host policy/services; no copied parent tools or stores. */
  getSubagentConfig(spec?: SubagentSpec): AgentConfig {
    const child: AgentConfig = {
      name: spec?.name ?? `${this.name}-sub`,
      model: this.model,
      instructions:
        spec?.instructions ??
        "You are a focused subagent. Complete the assigned task and return a concise final report. Do not spawn further subagents unless asked.",
      tools: spec?.tools,
      maxToolRoundtrips: Math.min(spec?.maxToolRoundtrips ?? 8, this.config.maxToolRoundtrips ?? 10),
      executionPolicy: this.config.executionPolicy,
      approvalManager: this.approvalService ?? undefined,
      sandbox: this.config.sandbox,
      eventBus: this.eventBus,
      costTracker: this.config.costTracker,
      maxTokens: this.config.maxTokens,
      register: false,
      subagents: false,
    };
    return child;
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

    const result: ChatMessage[][] = [];
    const turns = groupConversationTurns(history);
    let used = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      const tokens = countConversationTokens(turns[i]);
      if (used + tokens > available) break;
      used += tokens;
      result.unshift(turns[i]);
    }

    return result.flat();
  }
}

function resolveMemoryConfig(config: AgentConfig): UnifiedMemoryConfig | undefined {
  const learning = config.learning;
  if (!config.memory && !learning) return undefined;

  const base: UnifiedMemoryConfig = config.memory ? { ...config.memory } : { storage: new InMemoryStorage() };

  if (learning && !base.learnings) {
    base.learnings = learning;
  }

  return base;
}
