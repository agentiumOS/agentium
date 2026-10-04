import type { RunOpts, RunOutput } from "../agent/types.js";
import type { ChatMessage } from "../models/types.js";
import type { ApprovalManager } from "../tools/approval.js";
import type { HandoffSignal } from "./types.js";

// Control authority is process-local, never reconstructed from tool text, metadata or JSON.
const transfers = new WeakMap<object, HandoffSignal>();
export function setHandoffControl(result: object, signal: HandoffSignal): void {
  transfers.set(result, signal);
}
export function getHandoffControl(result: object): HandoffSignal | undefined {
  return transfers.get(result);
}
export function clearHandoffControl(result: object): void {
  transfers.delete(result);
}

export interface HandoffScope {
  chain: readonly string[];
  remaining: number;
  approvals: readonly ApprovalManager[];
  state?: Record<string, unknown>;
  /** Internal stream continuation; never reconstructed from caller metadata. */
  stream?: {
    continuation: boolean;
    transcript: ChatMessage[];
    complete(output: RunOutput): void;
  };
}
const scopes = new WeakMap<RunOpts, HandoffScope>();
export function getHandoffScope(opts?: RunOpts): HandoffScope | undefined {
  return opts && scopes.get(opts);
}
export function setHandoffScope(opts: RunOpts, scope: HandoffScope): void {
  scopes.set(opts, scope);
}
