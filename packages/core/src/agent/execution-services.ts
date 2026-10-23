import type { ModelProvider } from "../models/provider.js";
import type { PublicMessageEvent } from "../models/public-messages.js";
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
import type { ToolCallResult, ToolDef, ToolResult } from "../tools/types.js";
import type { InputReply, InputRequestOptions, RunInput } from "./conversation-input.js";
import type { RunContext } from "./run-context.js";

/** Host-supplied execution boundary. Core consumes these operations; it does not
 * construct or own the host's orchestration, configuration, or resource lifecycle.
 */
export interface ExecutionServices {
  /** Durable native execution serializes tools to commit causal state safely. */
  readonly toolConcurrency?: number;
  /** Propagate host control flow (for example durable input suspension). */
  isControlFlowError?(error: unknown): boolean;
  /** Retain one complete tool outcome, including authorization and output transforms. */
  executeTool?(call: ToolCall, context: RunContext, execute: () => Promise<ToolCallResult>): Promise<ToolCallResult>;
  readonly rootExecution?: import("./root-execution.js").RootExecutionController;
  /** Journal a validated/authorized invocation. Call execute only for fresh dispatch;
   * recorded results can return without a new root work attempt. */
  invokeTool?(
    tool: ToolDef,
    call: ToolCall,
    args: Record<string, unknown>,
    context: RunContext,
    execute: () => Promise<string | ToolResult>,
  ): Promise<string | ToolResult>;
  /** Suspend a live tool or driver until a correlated user reply arrives. */
  requestInput?(request: InputRequestOptions): Promise<InputReply>;
  /** Consume steering only at a complete conversation boundary. */
  takeInput?(context?: RunContext): RunInput | undefined;
  publishMessage?(event: PublicMessageEvent): void;
  /** Close steering atomically when the root conversation loop finishes. */
  finishInput?(context: RunContext): void;
  readonly ctx: RunContext;
  readonly signal: AbortSignal;
  readonly tools: readonly ToolDef[];
  readonly history: readonly ChatMessage[];
  /** Archive closed records before returning a bounded resident replay window. */
  retainHistory?(
    provider: ModelProvider,
    messages: readonly ChatMessage[],
    context?: RunContext,
  ): Promise<ChatMessage[]>;
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
  /** Observe every already-settled result before cancellation or control hooks stop
   * batch processing. This callback records evidence only and must tolerate abort.
   */
  observeToolSettlements?(results: readonly ToolCallResult[], context?: RunContext): Promise<void>;
  observeTool(result: ToolCallResult, context?: RunContext): Promise<void>;
  dispatchEffect<T>(
    name: string,
    args: Record<string, unknown>,
    execute: (args: Record<string, unknown>, ctx: RunContext) => Promise<T>,
  ): Promise<T>;
  dispatch(call: ToolCall): Promise<ToolCallResult>;
  recordConversation(executionId: string, messages: readonly ChatMessage[]): void;
}
