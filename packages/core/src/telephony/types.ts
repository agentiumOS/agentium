/** Host-verified identity. Never populate this from a dial payload or webhook alone. */
export interface CallIdentity {
  tenantId: string;
  userId: string;
}
export interface OutboundCallRequest {
  /** Stable within the tenant; persisted before dispatch. Reuse only for identical input. */
  intentId: string;
  identity: CallIdentity;
  routeId: string;
  to: string;
  from: string;
}
export interface CallOperationOptions {
  /** Aborts local waiting/network, never promises a remote hangup. */
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type CallStatus =
  | "queued"
  | "ringing"
  | "active"
  | "completed"
  | "busy"
  | "no-answer"
  | "cancelled"
  | "failed"
  | "unknown";
export interface CallReference {
  providerId: string;
  routeId: string;
  callId: string;
  /** Only LiveKit uses these, with a configured room and deterministic participant. */
  roomName?: string;
  participantIdentity?: string;
}
export interface CallSnapshot {
  ref: CallReference;
  status: CallStatus;
  /** Bounded native status; no raw responses, credentials or recording URLs. */
  providerStatus: string;
}
export interface NormalizedCallEvent extends CallSnapshot {
  eventId?: string;
  occurredAt?: string;
}
export interface CallHangupResult {
  ref: CallReference;
  /** Acceptance of the command is not terminal call evidence. */
  acknowledged: true;
}
export interface OutboundCallProvider {
  readonly id: string;
  readonly routeId: string;
  readonly capabilities: Readonly<{
    transport: "http" | "livekit-sip";
    /** All supplied adapters require reconciliation after ambiguous dispatch. */
    automaticCreateRetry: false;
    callbackVerification: "host";
    hangup: "call" | "active-legs" | "sip-participant";
  }>;
  create(request: OutboundCallRequest, options?: CallOperationOptions): Promise<CallSnapshot>;
  get(ref: CallReference, options?: CallOperationOptions): Promise<CallSnapshot>;
  hangup(ref: CallReference, options?: CallOperationOptions): Promise<CallHangupResult>;
  /** Parse only AFTER the host verifies provider signature, account, freshness and replay. */
  normalizeVerifiedEvent(payload: unknown): NormalizedCallEvent;
}
export type CallFailureOutcome = "not-dispatched" | "rejected" | "unknown";
export type CallErrorCode =
  | "invalid-input"
  | "unauthorized"
  | "conflict"
  | "not-found"
  | "capacity"
  | "aborted"
  | "timeout"
  | "provider-rejected"
  | "provider-unavailable"
  | "invalid-response"
  | "unresolved"
  | "store-unavailable";
/** Safe to log: does not retain raw provider errors, payloads, URLs or credential causes. */
export class TelephonyError extends Error {
  constructor(
    readonly code: CallErrorCode,
    readonly outcome: CallFailureOutcome,
    readonly httpStatus?: number,
  ) {
    super(`Telephony operation failed: ${code} (${outcome})`);
    this.name = "TelephonyError";
  }
}
export interface CallRouteConfig {
  routeId: string;
  /** A host allowlist, snapshotted when the provider is constructed. */
  allowedFrom: readonly string[];
}
export interface TelephonyHttpConfig extends CallRouteConfig {
  /** Resolves a complete Authorization header; allows rotating Basic/Bearer credentials. */
  authorization: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export interface CallIntentRecord {
  request: OutboundCallRequest;
  providerId: string;
  digest: string;
  revision: number;
  creation: "dispatching" | "accepted" | "rejected" | "unknown";
  snapshot?: CallSnapshot;
  hangup: "none" | "dispatching" | "acknowledged" | "unknown" | "rejected";
  errorCode?: CallErrorCode;
}
export interface CallIntentKey {
  tenantId: string;
  intentId: string;
}
/** Production implementations MUST make claim and revision CAS atomic and durable.
 * Never expire unresolved entries: eviction permits a duplicate outbound call.
 * Scope the unique index to tenantId + intentId, and enforce immutable request/digest/provider.
 */
export interface CallIntentStore {
  claim(record: CallIntentRecord): Promise<{ claimed: boolean; record: CallIntentRecord }>;
  get(key: CallIntentKey): Promise<CallIntentRecord | undefined>;
  compareAndSet(key: CallIntentKey, revision: number, next: CallIntentRecord): Promise<boolean>;
}
export interface CallAuthorization {
  operation: "create" | "read" | "hangup" | "reconcile" | "event";
  identity: CallIdentity;
  request: OutboundCallRequest;
  ref?: CallReference;
}
