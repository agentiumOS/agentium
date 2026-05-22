import { createRequire } from "node:module";
import type { RunContext } from "../agent/run-context.js";
import type { ToolCall } from "../models/types.js";
import type { ApprovalConfig } from "./approval.js";
import { ApprovalManager } from "./approval.js";
import { resolveSandboxConfig, Sandbox } from "./sandbox.js";
import type { SandboxConfig, ToolCallResult, ToolDef, ToolResult } from "./types.js";

const _require = createRequire(import.meta.url);

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
  agentName?: string;
  onToolCall?: (ctx: RunContext, toolName: string, args: unknown) => Promise<void>;
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
  private agentName: string;
  private onToolCall?: (ctx: RunContext, toolName: string, args: unknown) => Promise<void>;

  constructor(tools: ToolDef[], configOrConcurrency?: number | ToolExecutorConfig) {
    this.tools = new Map(tools.map((t) => [t.name, t]));

    if (typeof configOrConcurrency === "number" || configOrConcurrency === undefined) {
      this.concurrency = configOrConcurrency ?? 5;
      this.agentName = "";
    } else {
      this.concurrency = configOrConcurrency.concurrency ?? 5;
      this.agentSandbox = configOrConcurrency.sandbox;
      this.agentName = configOrConcurrency.agentName ?? "";
      this.onToolCall = configOrConcurrency.onToolCall;

      if (configOrConcurrency.approval && configOrConcurrency.approval.policy !== "none") {
        this.approvalManager = new ApprovalManager(configOrConcurrency.approval);
      }
    }

    this.cachedDefs = this.buildToolDefinitions();
  }

  getApprovalManager(): ApprovalManager | undefined {
    return this.approvalManager;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(toolName: string, args: Record<string, unknown>): string {
    const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
    return `${toolName}:${sortedArgs}`;
  }

  private getCached(toolName: string, args: Record<string, unknown>): (string | ToolResult) | undefined {
    const tool = this.tools.get(toolName);
    if (!tool?.cache) return undefined;

    const key = this.getCacheKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  private setCache(toolName: string, args: Record<string, unknown>, result: string | ToolResult): void {
    const tool = this.tools.get(toolName);
    if (!tool?.cache) return;

    const key = this.getCacheKey(toolName, args);
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + tool.cache.ttl,
    });
  }

  async executeAll(toolCalls: ToolCall[], ctx: RunContext): Promise<ToolCallResult[]> {
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
          results.push({
            toolCallId: tc.id,
            toolName: tc.name,
            result: `Error: ${settled.reason?.message ?? "Unknown error"}`,
            error: settled.reason?.message ?? "Unknown error",
          });
        }
      }
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

    ctx.eventBus.emit("tool.call", {
      runId: ctx.runId,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    if (this.onToolCall) {
      await this.onToolCall(ctx, toolCall.name, toolCall.arguments);
    }

    if (this.approvalManager) {
      const needs = this.approvalManager.needsApproval(toolCall.name, toolCall.arguments, tool.requiresApproval);

      if (needs) {
        const decision = await this.approvalManager.check(toolCall.name, toolCall.arguments, ctx, this.agentName);

        if (!decision.approved) {
          const reason = decision.reason ?? "Tool call denied by human reviewer";
          ctx.eventBus.emit("tool.result", {
            runId: ctx.runId,
            toolName: toolCall.name,
            result: reason,
          });
          return {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: `[DENIED] ${reason}`,
            error: reason,
          };
        }
      }
    }

    const cachedResult = this.getCached(toolCall.name, toolCall.arguments);
    if (cachedResult !== undefined) {
      const resultContent = typeof cachedResult === "string" ? cachedResult : cachedResult.content;

      ctx.eventBus.emit("tool.result", {
        runId: ctx.runId,
        toolName: toolCall.name,
        result: `[cached] ${resultContent}`,
      });

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: cachedResult,
      };
    }

    const parsed = tool.parameters.safeParse(toolCall.arguments);
    if (!parsed.success) {
      const errMsg = `Invalid arguments: ${parsed.error.message}`;
      const result: ToolCallResult = {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        result: errMsg,
        error: errMsg,
      };

      ctx.eventBus.emit("tool.result", {
        runId: ctx.runId,
        toolName: toolCall.name,
        result: errMsg,
      });

      return result;
    }

    const sandboxConfig = resolveSandboxConfig(tool.sandbox, this.agentSandbox);
    let rawResult: string | ToolResult;

    if (sandboxConfig) {
      const sandbox = new Sandbox(sandboxConfig);
      rawResult = await sandbox.execute(tool.execute, parsed.data, ctx);
    } else {
      rawResult = await tool.execute(parsed.data, ctx);
    }

    const resultContent = typeof rawResult === "string" ? rawResult : rawResult.content;

    this.setCache(toolCall.name, toolCall.arguments, rawResult);

    ctx.eventBus.emit("tool.result", {
      runId: ctx.runId,
      toolName: toolCall.name,
      result: resultContent,
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
    const { zodToJsonSchema } = _require("zod-to-json-schema");
    const defs: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    }> = [];

    for (const tool of this.tools.values()) {
      if (tool.rawJsonSchema) {
        defs.push({
          name: tool.name,
          description: tool.description,
          parameters: stripJsonSchema(tool.rawJsonSchema),
          ...(tool.strict ? { strict: true } : {}),
        });
      } else {
        const jsonSchema = zodToJsonSchema(tool.parameters, {
          target: "jsonSchema7",
          $refStrategy: "none",
        }) as Record<string, unknown>;

        const stripped = stripJsonSchema(jsonSchema);

        if (tool.strict) {
          stripped.additionalProperties = false;
        }

        defs.push({
          name: tool.name,
          description: tool.description,
          parameters: stripped,
          ...(tool.strict ? { strict: true } : {}),
        });
      }
    }

    return defs;
  }
}
