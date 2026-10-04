import { randomUUID as uuidv4 } from "node:crypto";
import type { RunContext } from "../agent/run-context.js";
import type { EventBus } from "../events/event-bus.js";

export interface ApprovalRequest {
  requestId: string;
  toolName: string;
  args: unknown;
  agentName: string;
  runId: string;
  sessionId?: string;
  userId?: string;
  tenantId?: string;
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

interface PendingApproval {
  request: ApprovalRequest;
  finish: (decision: ApprovalDecision) => void;
}

/** A host-owned dispatcher that may be shared by concurrent run-local executors. */
export class ApprovalManager {
  private policy: "none" | "all" | string[];
  private onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  private timeout: number;
  private timeoutAction: "approve" | "deny" | "throw";
  private eventBus?: EventBus;
  private pending = new Map<string, PendingApproval>();
  private closed = false;

  constructor(config: ApprovalConfig & { eventBus?: EventBus }) {
    this.policy = config.policy;
    this.onApproval = config.onApproval;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.timeoutAction = config.timeoutAction ?? "deny";
    this.eventBus = config.eventBus;
  }

  /** Unfiltered access is for the trusted owner; hosted callers must supply verified scope. */
  listPending(scope?: { runId?: string; sessionId?: string; userId?: string; tenantId?: string }): ApprovalRequest[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter(
        (request) =>
          !scope || Object.entries(scope).every(([key, value]) => request[key as keyof ApprovalRequest] === value),
      );
  }

  needsApproval(
    toolName: string,
    args: Record<string, unknown>,
    toolRequiresApproval?: boolean | ((args: Record<string, unknown>) => boolean),
  ): boolean {
    // These are legacy per-tool overrides, not mandatory host policy.
    if (toolRequiresApproval !== undefined) {
      return typeof toolRequiresApproval === "function" ? toolRequiresApproval(args) : toolRequiresApproval;
    }
    if (this.policy === "none") return false;
    if (this.policy === "all") return true;
    return this.policy.includes(toolName);
  }

  async check(toolName: string, args: unknown, ctx: RunContext, agentName: string): Promise<ApprovalDecision> {
    if (this.closed || ctx.signal?.aborted) {
      return { approved: false, reason: this.closed ? "Approval service closed" : "Run cancelled" };
    }
    const request: ApprovalRequest = {
      requestId: uuidv4(),
      toolName,
      args,
      agentName,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
    };
    const eventBus = this.eventBus ?? ctx.eventBus;
    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(request.requestId);
      };
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(decision);
        eventBus.emit("tool.approval.response", { requestId: request.requestId, ...decision });
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => finish({ approved: false, reason: "Run cancelled" });
      const timer = setTimeout(() => {
        try {
          finish(this.makeTimeoutDecision());
        } catch (error) {
          fail(error);
        }
      }, this.timeout);
      // Install before the event: a synchronous listener can approve immediately.
      this.pending.set(request.requestId, { request, finish });
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        eventBus.emit("tool.approval.request", request);
        if (this.onApproval && !settled) {
          Promise.resolve(this.onApproval(request)).then(finish, fail);
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  approve(requestId: string, reason?: string): void {
    this.pending.get(requestId)?.finish({ approved: true, reason });
  }

  deny(requestId: string, reason?: string): void {
    this.pending.get(requestId)?.finish({ approved: false, reason });
  }

  cancelRun(runId: string, reason = "Run cancelled"): void {
    for (const entry of this.pending.values()) {
      if (entry.request.runId === runId) entry.finish({ approved: false, reason });
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.finish({ approved: false, reason: "Approval service closed" });
  }

  private makeTimeoutDecision(): ApprovalDecision {
    if (this.timeoutAction === "approve") return { approved: true, reason: "Auto-approved on timeout" };
    if (this.timeoutAction === "throw") throw new Error("Approval timed out (configured to throw)");
    return { approved: false, reason: "Approval timed out" };
  }
}
