import type { DurableActionConnector, DurableJSON, DurableTaskStore } from "@agentium/core";

export interface WatchIdentity {
  tenantId: string;
  actorId: string;
}
export interface WatchQuietHours {
  start: string;
  end: string;
}
export interface WatchLimits {
  maxOperations: number;
  maxWakes: number;
  maxEventsPerWake: number;
  maxPagesPerWake: number;
  maxResyncEvents: number;
  maxPendingEvents: number;
  maxDecisions: number;
  maxOutbox: number;
  maxEventBytes: number;
  maxStateBytes: number;
  maxNotificationsPerDay: number;
}
export interface WatchDefinition {
  id: string;
  version: number;
  identity: WatchIdentity;
  sourceId: string;
  sourceScope: string;
  destination: string;
  channel: string;
  policyRevision: number;
  grantRefs: string[];
  timeZone: string;
  quietHours?: WatchQuietHours;
  pollIntervalMs: number;
  renewalIntervalMs: number;
  cooldownMs: number;
  limits: WatchLimits;
}
export type WatchDefinitionInput = Omit<
  WatchDefinition,
  "limits" | "pollIntervalMs" | "renewalIntervalMs" | "cooldownMs"
> & {
  limits?: Partial<WatchLimits>;
  pollIntervalMs?: number;
  renewalIntervalMs?: number;
  cooldownMs?: number;
};
export interface WatchEvent {
  id: string;
  occurredAt: number;
  data: DurableJSON;
}
export interface WatchSubscription {
  reference: string;
  expiresAt: number;
}
export interface WatchSourceBatch {
  cursor: string;
  events: WatchEvent[];
  resynced: boolean;
}
export interface VerifiedWatchTrigger extends WatchIdentity {
  sourceId: string;
  sourceScope: string;
  eventId: string;
  cursor: string;
}
/** A scoped, host-owned source. Implementations must honor read bounds before returning a cursor. */
export interface WatchSource {
  id: string;
  scope: string;
  capabilities: { idempotentActivation: true; polling: true; push: boolean };
  baseline(signal: AbortSignal): Promise<string>;
  activate(key: string, signal: AbortSignal): Promise<WatchSubscription>;
  stop(subscription: WatchSubscription | null, signal: AbortSignal): Promise<void>;
  read(
    cursor: string,
    limits: Pick<WatchLimits, "maxEventsPerWake" | "maxPagesPerWake" | "maxResyncEvents">,
    signal: AbortSignal,
  ): Promise<WatchSourceBatch>;
  compareCursors(left: string, right: string): number;
  /** Verify signature/audience and authenticated mailbox ownership before returning a trusted hint. */
  verifyTrigger?(raw: unknown): Promise<VerifiedWatchTrigger>;
}
export type WatchScheduleKind = "poll" | "renew" | "flush";
export interface WatchSchedule {
  key: string;
  identity: WatchIdentity;
  watchId: string;
  configVersion: number;
  kind: WatchScheduleKind;
  at: number;
}
export interface WatchScheduler {
  capabilities: { durable: boolean; idempotentUpsert: true };
  schedule(job: WatchSchedule): Promise<void>;
  cancel(key: string): Promise<void>;
}
export type WatchOperation =
  | "activate"
  | "update"
  | "pause"
  | "resume"
  | "delete"
  | "trigger"
  | "poll"
  | "renew"
  | "flush"
  | "reconcile"
  | "inspect";
export interface WatchAuthorization {
  operation: WatchOperation;
  definition: Readonly<WatchDefinition>;
  /** Notification count includes digests; authorization must validate destination/channel and amount. */
  notifications: number;
  events: number;
}
export interface WatchServices {
  store: DurableTaskStore;
  source: WatchSource;
  scheduler: WatchScheduler;
  notifications: DurableActionConnector & { channel: string; destination: string };
  /** Trusted host authority, including exclusive ownership of a source mailbox where required. */
  authorize(request: WatchAuthorization): Promise<boolean>;
  /** Deterministic local classification only; no model/network work in this callback. */
  filter?(event: Readonly<WatchEvent>): boolean;
  leaseMs?: number;
  requireDurability?: boolean;
}
export interface WatchOutbox {
  id: string;
  eventIds: string[];
  events: WatchEvent[];
  state: "pending" | "confirmed";
  reservedDay: string | null;
  resultRef: string | null;
}
export interface WatchState {
  status: "inactive" | "activating" | "active" | "paused" | "deleted";
  cursor: string | null;
  subscription: WatchSubscription | null;
  wakes: number;
  decisions: Record<string, { id: string; decision: "pending" | "ignored" | "resync" | "outbox"; at: number }>;
  pending: WatchEvent[];
  outbox: Record<string, WatchOutbox>;
  daily: Record<string, number>;
  cooldownUntil: number;
  schedules: Partial<Record<WatchScheduleKind, number>>;
}
