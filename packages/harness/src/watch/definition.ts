import { durableCanonical, durableDigest } from "@agentium/core";
import { quietMinute, watchClock } from "./quiet-hours.js";
import type { WatchDefinition, WatchDefinitionInput, WatchLimits } from "./types.js";

const defaults: WatchLimits = {
  maxOperations: 4096,
  maxWakes: 1000,
  maxEventsPerWake: 100,
  maxPagesPerWake: 5,
  maxResyncEvents: 100,
  maxPendingEvents: 256,
  maxDecisions: 4096,
  maxOutbox: 128,
  maxEventBytes: 8192,
  maxStateBytes: 512_000,
  maxNotificationsPerDay: 20,
};
export function watchId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    ["__proto__", "constructor", "prototype"].includes(value)
  )
    throw new Error("Invalid watch identifier");
}
function integer(value: number, max = Number.MAX_SAFE_INTEGER, zero = false): void {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max)
    throw new Error("Watch limit outside supported bounds");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Pure definition: validates/copies JSON, without binding services or activating anything. */
export function defineWatch(input: WatchDefinitionInput): WatchDefinition {
  durableCanonical(input);
  const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !object(input) ||
    !object(input.identity) ||
    !Array.isArray(input.grantRefs) ||
    (input.limits !== undefined && !object(input.limits)) ||
    (input.quietHours !== undefined && !object(input.quietHours))
  )
    throw new Error("Invalid watch configuration shape");
  const keys = new Set([
    "id",
    "version",
    "identity",
    "sourceId",
    "sourceScope",
    "destination",
    "channel",
    "policyRevision",
    "grantRefs",
    "timeZone",
    "quietHours",
    "pollIntervalMs",
    "renewalIntervalMs",
    "cooldownMs",
    "limits",
  ]);
  if (
    Object.keys(input).some((key) => !keys.has(key)) ||
    Object.keys(input.identity).some((key) => !["tenantId", "actorId"].includes(key)) ||
    Object.keys(input.limits ?? {}).some((key) => !(key in defaults)) ||
    (input.quietHours && Object.keys(input.quietHours).some((key) => !["start", "end"].includes(key)))
  )
    throw new Error("Unknown watch configuration field");
  const definition = structuredClone({
    ...input,
    pollIntervalMs: input.pollIntervalMs ?? 300_000,
    renewalIntervalMs: input.renewalIntervalMs ?? 86_400_000,
    cooldownMs: input.cooldownMs ?? 60_000,
    limits: { ...defaults, ...input.limits },
  });
  for (const value of [
    definition.id,
    definition.identity.tenantId,
    definition.identity.actorId,
    definition.sourceId,
    definition.sourceScope,
    definition.destination,
    definition.channel,
    definition.timeZone,
    ...definition.grantRefs,
  ])
    watchId(value);
  if (!definition.grantRefs.length || new Set(definition.grantRefs).size !== definition.grantRefs.length)
    throw new Error("Watch requires distinct host grant references");
  integer(definition.version);
  integer(definition.policyRevision, Number.MAX_SAFE_INTEGER, true);
  integer(definition.pollIntervalMs, 86_400_000);
  integer(definition.renewalIntervalMs, 86_400_000);
  integer(definition.cooldownMs, 30 * 86_400_000, true);
  for (const value of Object.values(definition.limits)) integer(value);
  integer(definition.limits.maxOperations, 10000);
  integer(definition.limits.maxEventsPerWake, 1000);
  integer(definition.limits.maxPagesPerWake, 100);
  integer(definition.limits.maxResyncEvents, 1000);
  integer(definition.limits.maxPendingEvents, 1000);
  integer(definition.limits.maxEventBytes, 65536);
  integer(definition.limits.maxStateBytes, 1_500_000);
  watchClock(0, definition.timeZone);
  if (definition.quietHours && quietMinute(definition.quietHours.start) === quietMinute(definition.quietHours.end))
    throw new Error("Use pause for all-day quiet hours");
  return freeze(definition);
}
export function describeWatch(definition: WatchDefinitionInput) {
  const config = defineWatch(definition);
  return {
    definition: config,
    hash: durableDigest(config),
    activation: "explicit" as const,
    modelCalls: false as const,
  };
}
