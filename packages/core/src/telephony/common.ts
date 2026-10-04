import { z } from "zod";
import {
  type CallOperationOptions,
  type CallReference,
  type CallRouteConfig,
  type CallSnapshot,
  type CallStatus,
  type OutboundCallRequest,
  TelephonyError,
  type TelephonyHttpConfig,
} from "./types.js";

const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:@-]+$/);
const phone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
export const identitySchema = z.object({ tenantId: token, userId: token }).strict();
export const requestSchema = z
  .object({ intentId: token, identity: identitySchema, routeId: token, to: phone, from: phone })
  .strict();
const referenceSchema = z
  .object({
    providerId: token,
    routeId: token,
    callId: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_.:+/=-]+$/),
    roomName: token.optional(),
    participantIdentity: token.optional(),
  })
  .strict();
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TelephonyError("invalid-input", "not-dispatched");
  return parsed.data;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TelephonyError("invalid-response", "unknown");
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 1024): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new TelephonyError("invalid-response", "unknown");
  return value;
}
export function route(config: CallRouteConfig): CallRouteConfig {
  const routeId = parseInput(token, config.routeId);
  const allowedFrom = parseInput(z.array(phone).min(1).max(100), config.allowedFrom);
  return Object.freeze({ routeId, allowedFrom: Object.freeze(allowedFrom) });
}
export function validateRequest(value: OutboundCallRequest, config: CallRouteConfig): OutboundCallRequest {
  const request = parseInput(requestSchema, value);
  if (request.routeId !== config.routeId || !config.allowedFrom.includes(request.from))
    throw new TelephonyError("unauthorized", "not-dispatched");
  return request;
}
export function validateRef(value: CallReference, providerId: string, routeId: string): CallReference {
  const ref = parseInput(referenceSchema, value);
  if (ref.providerId !== providerId || ref.routeId !== routeId)
    throw new TelephonyError("invalid-input", "not-dispatched");
  return ref;
}

export function sameReference(a: CallReference, b: CallReference): boolean {
  return (
    a.providerId === b.providerId &&
    a.routeId === b.routeId &&
    a.callId === b.callId &&
    a.roomName === b.roomName &&
    a.participantIdentity === b.participantIdentity
  );
}
export function makeRef(providerId: string, routeId: string, callId: unknown): CallReference {
  try {
    return validateRef({ providerId, routeId, callId: string(callId) }, providerId, routeId);
  } catch {
    throw new TelephonyError("invalid-response", "unknown");
  }
}
export function safeUrl(value: string, protocol: "https:" | "wss:" = "https:"): string {
  try {
    const url = new URL(value);
    if (url.protocol !== protocol || url.username || url.password || url.hash || value.length > 2048) throw new Error();
    return url.href;
  } catch {
    throw new TelephonyError("invalid-input", "not-dispatched");
  }
}
export function safeOrigin(value: string): string {
  const url = new URL(safeUrl(value));
  if (url.pathname !== "/" || url.search) throw new TelephonyError("invalid-input", "not-dispatched");
  return url.origin;
}
const statuses: Readonly<Record<string, CallStatus>> = Object.freeze({
  queued: "queued",
  initiated: "queued",
  started: "queued",
  dialing: "queued",
  ringing: "ringing",
  "in-progress": "active",
  answered: "active",
  active: "active",
  completed: "completed",
  hangup: "completed",
  busy: "busy",
  "no-answer": "no-answer",
  unanswered: "no-answer",
  timeout: "no-answer",
  canceled: "cancelled",
  cancelled: "cancelled",
  failed: "failed",
  rejected: "failed",
});
export function status(value: unknown): CallStatus {
  return typeof value === "string" ? (statuses[value] ?? "unknown") : "unknown";
}
export function snapshot(ref: CallReference, native: unknown): CallSnapshot {
  const providerStatus =
    typeof native === "string" && native.length <= 100 && /^[a-zA-Z0-9_. -]+$/.test(native) ? native : "unknown";
  return { ref, providerStatus, status: status(providerStatus) };
}
export function terminal(value: CallStatus): boolean {
  return ["completed", "busy", "no-answer", "cancelled", "failed"].includes(value);
}
export function deadline(
  options: CallOperationOptions = {},
  fallback = 15_000,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = options.timeoutMs ?? fallback;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw new TelephonyError("invalid-input", "not-dispatched");
  if (options.signal?.aborted) throw new TelephonyError("aborted", "not-dispatched");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}
/** Observes late rejections of non-cancellable SDK/host ports. */
export async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new TelephonyError("aborted", "not-dispatched");
  let listener: (() => void) | undefined;
  let invoked = false;
  const abort = new Promise<never>((_, reject) => {
    listener = () => reject(new TelephonyError("aborted", invoked ? "unknown" : "not-dispatched"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        // Cancellation may arrive after scheduling but before the effect is invoked.
        if (signal.aborted) throw new TelephonyError("aborted", "not-dispatched");
        invoked = true;
        return operation();
      }),
      abort,
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}
export function http(config: TelephonyHttpConfig) {
  const fetchPort = config.fetch ?? globalThis.fetch;
  const authorizationPort = config.authorization;
  const timeoutMs = config.timeoutMs;
  if (typeof fetchPort !== "function" || typeof authorizationPort !== "function")
    throw new TelephonyError("invalid-input", "not-dispatched");
  return async (
    url: string,
    method: string,
    body: RequestInit["body"],
    options: CallOperationOptions = {},
    headers: Record<string, string> = {},
  ): Promise<unknown> => {
    const scope = deadline(options, timeoutMs);
    let dispatched = false;
    try {
      const authorization = await bounded(async () => authorizationPort(), scope.signal);
      if (typeof authorization !== "string" || !/^(Basic|Bearer) [^\r\n]+$/.test(authorization))
        throw new TelephonyError("invalid-input", "not-dispatched");
      if (scope.signal.aborted) throw new TelephonyError("aborted", "not-dispatched");
      const response = await bounded(() => {
        dispatched = true;
        return fetchPort(url, {
          method,
          body,
          signal: scope.signal,
          redirect: "error",
          headers: { Accept: "application/json", ...headers, Authorization: authorization },
        });
      }, scope.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new TelephonyError(
          "provider-rejected",
          response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown",
          response.status,
        );
      }
      if (response.status === 204) return undefined;
      const reader = response.body?.getReader();
      if (!reader) return undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await bounded(() => reader.read(), scope.signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65_536) throw new TelephonyError("invalid-response", "unknown");
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!size) return undefined;
      const bytes = Buffer.concat(chunks);
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        throw new TelephonyError("invalid-response", "unknown");
      }
    } catch (error) {
      if (error instanceof TelephonyError) {
        // A cancelled body read is still uncertain once the HTTP request was sent.
        if (dispatched && error.code === "aborted") throw new TelephonyError("aborted", "unknown");
        if (!dispatched && error.outcome === "unknown") throw new TelephonyError(error.code, "not-dispatched");
        throw error;
      }
      throw new TelephonyError(
        scope.signal.aborted ? "aborted" : "provider-unavailable",
        dispatched ? "unknown" : "not-dispatched",
      );
    } finally {
      scope.dispose();
    }
  };
}
export const jsonHeaders = { "Content-Type": "application/json" };
export const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
export function eventTime(value: unknown): string | undefined {
  return typeof value === "string" && value.length < 100 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}
