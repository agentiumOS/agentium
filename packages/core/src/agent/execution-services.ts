import type { ModelProvider } from "../models/provider.js";
import type {
  ChatMessage,
  ModelConfig,
  ModelResponse,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from "../models/types.js";
import type { ApprovalManager } from "../tools/approval.js";
import type { ExecutionPolicy } from "../tools/execution-policy.js";
import type { ToolCallResult, ToolDef } from "../tools/types.js";
import type { RunContext } from "./run-context.js";

/** Host-supplied execution boundary. Core consumes these operations; it does not
 * construct or own the host's orchestration, configuration, or resource lifecycle.
 */
export interface ExecutionServices {
  readonly ctx: RunContext;
  readonly signal: AbortSignal;
  readonly tools: readonly ToolDef[];
  readonly history: readonly ChatMessage[];
  readonly executionPolicy: ExecutionPolicy;
  readonly approvalManager?: ApprovalManager;
  readonly state: Record<string, unknown>;
  readonly sessionKey: string;
  model(
    provider: ModelProvider,
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
    context?: RunContext,
  ): Promise<ModelResponse>;
  streamModel(
    provider: ModelProvider,
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
    context?: RunContext,
  ): AsyncGenerator<StreamChunk>;
  runOwned<T>(operation: () => Promise<T>): Promise<T>;
  observeTool(result: ToolCallResult, context?: RunContext): Promise<void>;
  dispatchEffect<T>(
    name: string,
    args: Record<string, unknown>,
    execute: (args: Record<string, unknown>, ctx: RunContext) => Promise<T>,
  ): Promise<T>;
  dispatch(call: ToolCall): Promise<ToolCallResult>;
  recordConversation(executionId: string, messages: readonly ChatMessage[]): void;
}
