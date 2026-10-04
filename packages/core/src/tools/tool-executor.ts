import { serialize } from "node:v8";
import type { RunContext } from "../agent/run-context.js";
import { clearHandoffControl, getHandoffControl, setHandoffControl } from "../handoff/control.js";
import { HandoffSignal } from "../handoff/types.js";
import type { ToolCall } from "../models/types.js";
import { approxByteSize, storeArtifact } from "../state/artifact-store.js";
import type { ApprovalConfig } from "./approval.js";
import { ApprovalManager } from "./approval.js";
import type { ExecutionPolicy } from "./execution-policy.js";
import { evaluateExecutionPolicy } from "./execution-policy.js";
import { convertJsonSchema } from "./json-schema.js";
import { resolveSandboxConfig, Sandbox } from "./sandbox.js";
import { safeParseSchema } from "./schema.js";
import type { SandboxConfig, ToolCallResult, ToolDef, ToolResult } from "./types.js";

const STRIP_KEYS = new Set(["$schema", "title", "default", "examples", "$id", "$comment"]);

function stripJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIP_KEYS.has(key)) continue;
    if (key === "additionalProperties" && value === false) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripJsonSchema(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? stripJsonSchema(item as Record<string, unknown>)
          : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

interface CacheEntry {
  result: string | ToolResult;
  expiresAt: number;
}

export interface ToolExecutorConfig {
  concurrency?: number;
  sandbox?: boolean | SandboxConfig;
  approval?: ApprovalConfig & { eventBus?: import("../events/event-bus.js").EventBus };
  /** Share a host-owned dispatcher across run-local executors. */
  approvalManager?: ApprovalManager;
  /** Additional borrowed dispatchers whose approval requirements must also pass. */
  additionalApprovalManagers?: readonly ApprovalManager[];
  executionPolicy?: ExecutionPolicy;
  agentName?: string;
  /** Observe authorized calls. Mutating arguments of a protected call denies execution. */
  onToolCall?: (ctx: RunContext, toolName: string, args: unknown) => Promise<void>;
  /**
   * Memory Pointer Pattern: tool outputs over `maxToolOutputBytes` are auto-stored
   * as artifacts and replaced with a `{ pointer, preview }` JSON string before being
   * appended to the LLM context.
   */
  artifacts?: {
    maxToolOutputBytes: number;
    previewChars: number;
  };
  /**
   * Tool-loop detection: when the same `(toolName, arguments)` pair is invoked
   * more than `maxRepeats` times within a single run, take the configured action.
   *   - `"abort"`: raise `ToolLoopError` and stop the run
   *   - `"hint"`: return a synthetic result reminding the model to change strategy
   */
  loopDetection?: {
    maxRepeats: number;
    action: "abort" | "hint";
  };
}

export class ToolLoopError extends Error {
  readonly toolName: string;
  readonly repeats: number;
  constructor(toolName: string, repeats: number) {
    super(`Tool "${toolName}" was called ${repeats} times with identical arguments - aborting to prevent a loop`);
    this.name = "ToolLoopError";
    this.toolName = toolName;
    this.repeats = repeats;
  }
}

export class ToolExecutor {
  private tools: Map<string, ToolDef>;
  private concurrency: number;
  private cache = new Map<string, CacheEntry>();
  private cachedDefs: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  }> | null = null;
  private agentSandbox?: boolean | SandboxConfig;
  private approvalManager?: ApprovalManager;
  private additionalApprovalManagers: readonly ApprovalManager[] = [];
  private executionPolicy?: ExecutionPolicy;
  private agentName: string;
  private onToolCall?: (ctx: RunContext, toolName: string, args: unknown) => Promise<void>;
  private artifactsConfig?: { maxToolOutputBytes: number; previewChars: number };
  private loopDetection?: { maxRepeats: number; action: "abort" | "hint" };
  private callCounts = new Map<string, number>();

  constructor(tools: ToolDef[], configOrConcurrency?: number | ToolExecutorConfig) {
    this.tools = new Map();
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }

    if (typeof configOrConcurrency === "number" || configOrConcurrency === undefined) {
      this.concurrency = configOrConcurrency ?? 5;
      this.agentName = "";
    } else {
      this.concurrency = configOrConcurrency.concurrency ?? 5;
      this.agentSandbox = configOrConcurrency.sandbox;
      this.agentName = configOrConcurrency.agentName ?? "";
      this.onToolCall = configOrConcurrency.onToolCall;
      this.artifactsConfig = configOrConcurrency.artifacts;
      this.loopDetection = configOrConcurrency.loopDetection;

      this.executionPolicy = configOrConcurrency.executionPolicy;
      this.approvalManager = configOrConcurrency.approvalManager;
      this.additionalApprovalManagers = [...(configOrConcurrency.additionalApprovalManagers ?? [])];
      if (!this.approvalManager && configOrConcurrency.approval) {
        this.approvalManager = new ApprovalManager(configOrConcurrency.approval);
      }
    }

    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError("Tool concurrency must be a positive safe integer");
    }
    this.cachedDefs = this.buildToolDefinitions();
  }

  getApprovalManager(): ApprovalManager | undefined {
    return this.approvalManager;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(toolName: string, args: Record<string, unknown>, ctx: RunContext): string | undefined {
    try {
      // Lossless nested values and run identity: a reused executor must not return
      // another user's result, or collapse nested arguments to the same key.
      return serialize([ctx.runId, ctx.sessionId, ctx.userId, ctx.tenantId, toolName, args]).toString("base64");
    } catch {
      // Host-local arguments can contain functions or other nonserializable values.
      return undefined;
    }
  }

  private getCached(key: string | undefined): (string | ToolResult) | undefined {
    if (!key) return undefined;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  private setCache(key: string | undefined, ttl: number | undefined, result: string | ToolResult): void {
    if (!key || ttl === undefined) return;
    this.cache.set(key, { result, expiresAt: Date.now() + ttl });
  }

  async executeAll(toolCalls: ToolCall[], ctx: RunContext): Promise<ToolCallResult[]> {
    if (toolCalls.some((call) => !call.id) || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length)
      throw new Error("Tool batch requires nonempty unique call IDs");
    const results: ToolCallResult[] = [];

    for (let i = 0; i < toolCalls.length; i += this.concurrency) {
      const batch = toolCalls.slice(i, i + this.concurrency);
      const batchResults = await Promise.allSettled(batch.map((tc) => this.executeSingle(tc, ctx)));

      for (let j = 0; j < batchResults.length; j++) {
        const settled = batchResults[j];
        const tc = batch[j];

        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          // Bubble fatal "stop the run" errors up to the agent loop.
          if (settled.reason instanceof ToolLoopError) {
            throw settled.reason;
          }
          results.push({
            toolCallId: tc.id,
            toolName: tc.name,
            result: `Error: ${settled.reason?.message ?? "Unknown error"}`,
            error: settled.reason?.message ?? "Unknown error",
          });
        }
      }
    }

    const transfers = results.filter((result) => getHandoffControl(result));
    const blocked = transfers.length > 1 || results.some((result) => result.error) || ctx.signal?.aborted;
    for (const result of transfers) {
      if (blocked) {
        clearHandoffControl(result);
        result.error = ctx.signal?.aborted
          ? "Run cancelled"
          : transfers.length > 1
            ? "Multiple handoffs in one tool batch are ambiguous; no transfer performed"
            : "Handoff cancelled because another tool in the batch failed or was denied";
        result.result = result.error;
      }
      ctx.eventBus.emit("tool.result", {
        runId: ctx.runId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: result.result,
        status: ctx.signal?.aborted ? "cancelled" : result.error ? "error" : "success",
      });
    }
    return results;
  }

  private async executeSingle(toolCall: ToolCall, ctx: RunContext): Promise<ToolCallResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: `Error: Tool "${toolCall.name}" not found`,
        error: `Tool "${toolCall.name}" not found`,
      };
    }

    const reject = (reason: string, denial?: ToolCallResult["denial"]): ToolCallResult => {
      const result = denial ? `[DENIED] ${reason}` : reason;
      ctx.eventBus.emit("tool.result", {
        runId: ctx.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result,
        status: denial === "cancelled" ? "cancelled" : denial ? "denied" : "error",
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, result, error: reason, ...(denial ? { denial } : {}) };
    };
    const parsed = safeParseSchema(tool.parameters, toolCall.arguments);
    if (!parsed.success) return reject(`Invalid arguments: ${parsed.error.message}`);
    if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");

    const args = parsed.data;
    // Keep the parsed values (including Zod transforms) intact, while binding
    // authorization to their contents. Observers cannot substitute arguments
    // after policy or approval has reviewed a different call.
    const protectedCall = !!(
      ctx.executionPolicy ||
      this.executionPolicy ||
      this.approvalManager ||
      this.additionalApprovalManagers.length ||
      tool.requiresApproval ||
      ctx.runMode === "plan"
    );
    let authorizedArgs: Buffer | undefined;
    try {
      if (protectedCall) authorizedArgs = serialize(args);
    } catch {
      return reject("Tool arguments cannot be safely snapshotted for authorization", "policy");
    }
    const argumentsUnchanged = () => {
      try {
        return !authorizedArgs || authorizedArgs.equals(serialize(args));
      } catch {
        return false;
      }
    };
    const validatedCall = { toolCallId: toolCall.id, toolName: toolCall.name, args };
    let policy = await evaluateExecutionPolicy(ctx.executionPolicy ?? this.executionPolicy, validatedCall, ctx);
    if (ctx.executionPolicy && this.executionPolicy && ctx.executionPolicy !== this.executionPolicy) {
      const localPolicy = await evaluateExecutionPolicy(this.executionPolicy, validatedCall, ctx);
      if (localPolicy.action === "deny" || (policy.action === "allow" && localPolicy.action === "ask")) {
        policy = localPolicy;
      }
    }
    if (policy.action === "deny") return reject(policy.reason ?? "Execution policy denied tool call", "policy");
    if (!argumentsUnchanged()) return reject("Tool arguments changed during authorization", "policy");

    const managers = [
      ...new Set(
        [this.approvalManager, ...this.additionalApprovalManagers].filter(
          (manager): manager is ApprovalManager => !!manager,
        ),
      ),
    ];
    const needsApproval =
      managers.length === 0 &&
      (typeof tool.requiresApproval === "function" ? tool.requiresApproval(args) : tool.requiresApproval === true);
    if ((policy.action === "ask" || needsApproval) && managers.length === 0)
      return reject("Tool approval required but no approval service is configured", "approval_required");
    for (const manager of managers) {
      if (policy.action !== "ask" && !manager.needsApproval(toolCall.name, args, tool.requiresApproval)) continue;
      const decision = await manager.check(toolCall.name, args, ctx, this.agentName);
      if (decision.approved !== true)
        return reject(decision.reason ?? "Tool call denied by human reviewer", "approval_denied");
      if (!argumentsUnchanged()) return reject("Tool arguments changed during authorization", "policy");
    }
    if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");
    if (!argumentsUnchanged()) return reject("Tool arguments changed during authorization", "policy");

    if (this.loopDetection) {
      const sig = this.getCacheKey(toolCall.name, args, ctx) ?? `${ctx.runId}:${toolCall.name}:${JSON.stringify(args)}`;
      const count = (this.callCounts.get(sig) ?? 0) + 1;
      this.callCounts.set(sig, count);
      if (count > this.loopDetection.maxRepeats) {
        if (this.loopDetection.action === "abort") {
          throw new ToolLoopError(toolCall.name, count);
        }
        const hint =
          `[loop-detected] Tool "${toolCall.name}" has now been called ${count} times with identical arguments. ` +
          "Consider trying a different approach, changing the arguments, or finishing the response.";
        ctx.eventBus.emit("tool.result", {
          runId: ctx.runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result: hint,
          status: "error",
        });
        return { toolCallId: toolCall.id, toolName: toolCall.name, result: hint, error: "loop-detected" };
      }
    }

    ctx.eventBus.emit("tool.call", { runId: ctx.runId, toolCallId: toolCall.id, toolName: toolCall.name, args });
    if (this.onToolCall) await this.onToolCall(ctx, toolCall.name, args);
    if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");
    if (!argumentsUnchanged()) return reject("Tool arguments changed after authorization", "policy");

    // Authorization is checked for every invocation, including cache hits.
    const cacheKey = tool.cache ? this.getCacheKey(toolCall.name, args, ctx) : undefined;
    const cachedResult = this.getCached(cacheKey);
    if (cachedResult !== undefined) {
      const resultContent = typeof cachedResult === "string" ? cachedResult : cachedResult.content;
      ctx.eventBus.emit("tool.result", {
        runId: ctx.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: `[cached] ${resultContent}`,
        status: "success",
        cached: true,
      });
      return { toolCallId: toolCall.id, toolName: toolCall.name, result: cachedResult };
    }

    const sandboxConfig = resolveSandboxConfig(tool.sandbox, this.agentSandbox);
    let rawResult: string | ToolResult;

    try {
      if (sandboxConfig) {
        const sandbox = new Sandbox(sandboxConfig);
        rawResult = await sandbox.execute(tool.execute, parsed.data, ctx);
      } else {
        rawResult = await tool.execute(parsed.data, ctx);
      }
    } catch (error) {
      if (!(error instanceof HandoffSignal)) throw error;
      if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");
      const result: ToolCallResult = {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: `Transfer requested to "${error.targetAgent}"; the current tool batch must settle before delegation.`,
      };
      setHandoffControl(result, error);
      return result;
    }

    if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");
    // Per-tool result transform applied before any framework-level wrapping.
    if (tool.toModelOutput) {
      rawResult = await tool.toModelOutput(rawResult, ctx);
    }
    if (ctx.signal?.aborted) return reject("Run cancelled", "cancelled");

    // Memory Pointer Pattern: auto-convert oversized outputs to artifact pointers.
    // Skip artifact tools themselves so we don't recursively wrap their output.
    if (
      this.artifactsConfig &&
      toolCall.name !== "storeArtifact" &&
      toolCall.name !== "getArtifact" &&
      toolCall.name !== "listArtifacts"
    ) {
      const content = typeof rawResult === "string" ? rawResult : rawResult.content;
      if (approxByteSize(content) > this.artifactsConfig.maxToolOutputBytes) {
        const ptr = storeArtifact(ctx, content, {
          name: `${toolCall.name}_${toolCall.id}`,
          contentType: "text/plain",
          previewChars: this.artifactsConfig.previewChars,
        });
        const replacement = JSON.stringify({
          pointer: ptr.pointer,
          preview: ptr.preview,
          sizeBytes: ptr.sizeBytes,
          note: "Output too large; full value stored as artifact. Call getArtifact(pointer) to read it.",
        });
        if (typeof rawResult === "string") {
          rawResult = replacement;
        } else {
          rawResult = { ...rawResult, content: replacement };
        }
      }
    }

    const resultContent = typeof rawResult === "string" ? rawResult : rawResult.content;

    this.setCache(cacheKey, tool.cache?.ttl, rawResult);

    ctx.eventBus.emit("tool.result", {
      runId: ctx.runId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: resultContent,
      status: "success",
      cached: false,
    });

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: rawResult,
    };
  }

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  }> {
    if (this.cachedDefs) return this.cachedDefs;
    this.cachedDefs = this.buildToolDefinitions();
    return this.cachedDefs;
  }

  private buildToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  }> {
    const defs: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    }> = [];

    for (const tool of this.tools.values()) {
      const examplesSuffix =
        tool.inputExamples && tool.inputExamples.length > 0
          ? `\n\nExamples:\n${tool.inputExamples.map((ex, i) => `${i + 1}. ${JSON.stringify(ex)}`).join("\n")}`
          : "";
      const description = tool.description + examplesSuffix;

      if (tool.rawJsonSchema) {
        defs.push({
          name: tool.name,
          description,
          parameters: stripJsonSchema(tool.rawJsonSchema),
          ...(tool.strict ? { strict: true } : {}),
        });
      } else {
        const jsonSchema = convertJsonSchema(tool.parameters).schema;

        const stripped = stripJsonSchema(jsonSchema);

        if (tool.strict) {
          stripped.additionalProperties = false;
        }

        defs.push({
          name: tool.name,
          description,
          parameters: stripped,
          ...(tool.strict ? { strict: true } : {}),
        });
      }
    }

    return defs;
  }
}
