import { v4 as uuidv4 } from "uuid";
import type { RunContext } from "../agent/run-context.js";
import type { EventBus } from "../events/event-bus.js";

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  args: unknown;
  agentName: string;
  runId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface ApprovalConfig {
  /** Which tools require approval: "none" (default), "all", or an array of tool names. */
  policy: "none" | "all" | string[];
  /** Callback invoked when approval is needed. Return a decision. */
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Timeout in ms for waiting on human response. Default: 300000 (5 min). */
  timeout?: number;
  /** Default action when approval times out. Default: "deny". */
  timeoutAction?: "approve" | "deny" | "throw";
}

const DEFAULT_TIMEOUT = 300_000;

export class ApprovalManager {
  private policy: "none" | "all" | string[];
  private onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  private timeout: number;
  private timeoutAction: "approve" | "deny" | "throw";
  private eventBus?: EventBus;
  private pending = new Map<
    string,
    { resolve: (d: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout>; request: ApprovalRequest }
  >();

  constructor(config: ApprovalConfig & { eventBus?: EventBus }) {
    this.policy = config.policy;
    this.onApproval = config.onApproval;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.timeoutAction = config.timeoutAction ?? "deny";
    this.eventBus = config.eventBus;
  }

  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  needsApproval(
    toolName: string,
    args: Record<string, unknown>,
    toolRequiresApproval?: boolean | ((args: Record<string, unknown>) => boolean),
  ): boolean {
    if (toolRequiresApproval !== undefined) {
      if (typeof toolRequiresApproval === "function") {
        return toolRequiresApproval(args);
      }
      return toolRequiresApproval;
    }

    if (this.policy === "none") return false;
    if (this.policy === "all") return true;
    return this.policy.includes(toolName);
  }

  async check(toolName: string, args: unknown, ctx: RunContext, agentName: string): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      requestId: uuidv4(),
      toolName,
      args,
      agentName,
      runId: ctx.runId,
    };

    this.eventBus?.emit("tool.approval.request", request);

    if (this.onApproval) {
      return this.callbackMode(request);
    }

    return this.eventMode(request);
  }

  /** Externally approve a pending request (for event-driven mode). */
  approve(requestId: string, reason?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    const decision: ApprovalDecision = { approved: true, reason };
    this.eventBus?.emit("tool.approval.response", { requestId, ...decision });
    entry.resolve(decision);
  }

  /** Externally deny a pending request (for event-driven mode). */
  deny(requestId: string, reason?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    const decision: ApprovalDecision = { approved: false, reason };
    this.eventBus?.emit("tool.approval.response", { requestId, ...decision });
    entry.resolve(decision);
  }

  private makeTimeoutDecision(): ApprovalDecision {
    if (this.timeoutAction === "approve") {
      return { approved: true, reason: "Auto-approved on timeout" };
    }
    if (this.timeoutAction === "throw") {
      throw new Error("Approval timed out (configured to throw)");
    }
    return { approved: false, reason: "Approval timed out" };
  }

  private async callbackMode(request: ApprovalRequest): Promise<ApprovalDecision> {
    const timer = setTimeout(() => {}, this.timeout);

    try {
      const result = await Promise.race([
        this.onApproval!(request),
        new Promise<ApprovalDecision>((resolve, reject) =>
          setTimeout(() => {
            try {
              resolve(this.makeTimeoutDecision());
            } catch (e) {
              reject(e);
            }
          }, this.timeout),
        ),
      ]);

      this.eventBus?.emit("tool.approval.response", {
        requestId: request.requestId,
        ...result,
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private eventMode(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        let decision: ApprovalDecision;
        try {
          decision = this.makeTimeoutDecision();
        } catch (e) {
          reject(e);
          return;
        }
        this.eventBus?.emit("tool.approval.response", {
          requestId: request.requestId,
          ...decision,
        });
        resolve(decision);
      }, this.timeout);

      this.pending.set(request.requestId, { resolve, timer, request });
    });
  }
}
