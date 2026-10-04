import {
  eventTime,
  formHeaders,
  http,
  jsonHeaders,
  makeRef,
  record,
  route,
  safeOrigin,
  safeUrl,
  snapshot,
  string,
  terminal,
  validateRef,
  validateRequest,
} from "./common.js";
import {
  type CallReference,
  type CallSnapshot,
  type OutboundCallProvider,
  TelephonyError,
  type TelephonyHttpConfig,
} from "./types.js";

export interface TwilioCallConfig extends TelephonyHttpConfig {
  accountSid: string;
  answerUrl: string;
  statusCallbackUrl?: string;
}
export interface SignalWireCallConfig extends TwilioCallConfig {
  spaceUrl: string;
}
function segment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new TelephonyError("invalid-input", "not-dispatched");
  return encodeURIComponent(value);
}
function sameCall(expected: CallReference, observed: CallSnapshot): CallSnapshot {
  if (expected.callId !== observed.ref.callId) throw new TelephonyError("invalid-response", "unknown");
  return observed;
}
function compatibilityProvider(
  config: TwilioCallConfig,
  id: string,
  origin: string,
  prefix: string,
  suffix: string,
): OutboundCallProvider {
  const routing = route(config);
  const send = http(config);
  const accountSid = config.accountSid;
  const answer = safeUrl(config.answerUrl);
  const callback = config.statusCallbackUrl ? safeUrl(config.statusCallbackUrl) : undefined;
  const base = `${origin}${prefix}/Accounts/${segment(config.accountSid)}/Calls`;
  const parse = (value: unknown) => {
    const data = record(value);
    return snapshot(makeRef(id, routing.routeId, data.sid), data.status);
  };
  const callPath = (value: CallReference) =>
    `${base}/${encodeURIComponent(validateRef(value, id, routing.routeId).callId)}${suffix}`;
  return Object.freeze({
    id,
    routeId: routing.routeId,
    capabilities: Object.freeze({
      transport: "http",
      automaticCreateRetry: false,
      callbackVerification: "host",
      hangup: "call",
    }),
    async create(value, options) {
      const request = validateRequest(value, routing);
      const body = new URLSearchParams({ To: request.to, From: request.from, Url: answer, Method: "POST" });
      if (callback) {
        body.set("StatusCallback", callback);
        body.set("StatusCallbackMethod", "POST");
        for (const event of ["initiated", "ringing", "answered", "completed"])
          body.append("StatusCallbackEvent", event);
      }
      return parse(await send(`${base}${suffix}`, "POST", body, options, formHeaders));
    },
    async get(ref, options) {
      return sameCall(ref, parse(await send(callPath(ref), "GET", undefined, options)));
    },
    async hangup(ref, options) {
      // The API distinguishes queued cancellation from completion of an active call.
      const current = await this.get(ref, options);
      if (!terminal(current.status)) {
        const target = current.status === "queued" || current.status === "ringing" ? "canceled" : "completed";
        sameCall(
          ref,
          parse(await send(callPath(ref), "POST", new URLSearchParams({ Status: target }), options, formHeaders)),
        );
      }
      return { ref: { ...ref }, acknowledged: true };
    },
    normalizeVerifiedEvent(value) {
      const data = record(value);
      if (data.AccountSid !== accountSid) throw new TelephonyError("invalid-input", "not-dispatched");
      return {
        ...snapshot(makeRef(id, routing.routeId, data.CallSid), data.CallStatus),
        occurredAt: eventTime(data.Timestamp),
      };
    },
  } satisfies OutboundCallProvider);
}
/** Twilio Programmable Voice Call resource (2010-04-01). */
export function createTwilioCallProvider(config: TwilioCallConfig): OutboundCallProvider {
  return compatibilityProvider(config, "twilio", "https://api.twilio.com", "/2010-04-01", ".json");
}
/** SignalWire Compatibility/cXML API; not the separate SWML Calling API. */
export function createSignalWireCallProvider(config: SignalWireCallConfig): OutboundCallProvider {
  const origin = safeOrigin(config.spaceUrl);
  if (!new URL(origin).hostname.endsWith(".signalwire.com"))
    throw new TelephonyError("invalid-input", "not-dispatched");
  return compatibilityProvider(config, "signalwire", origin, "/api/laml/2010-04-01", "");
}
export interface TelnyxCallConfig extends TelephonyHttpConfig {
  connectionId: string;
  webhookUrl?: string;
}
export function createTelnyxCallProvider(config: TelnyxCallConfig): OutboundCallProvider {
  const routing = route(config);
  const send = http(config);
  const id = "telnyx";
  const connectionId = segment(config.connectionId);
  const webhook = config.webhookUrl ? safeUrl(config.webhookUrl) : undefined;
  const base = "https://api.telnyx.com/v2/calls";
  const ref = (value: unknown) => makeRef(id, routing.routeId, record(record(value).data).call_control_id);
  const callPath = (value: CallReference) =>
    `${base}/${encodeURIComponent(validateRef(value, id, routing.routeId).callId)}`;
  return Object.freeze({
    id,
    routeId: routing.routeId,
    capabilities: Object.freeze({
      transport: "http",
      automaticCreateRetry: false,
      callbackVerification: "host",
      hangup: "call",
    }),
    async create(value, options) {
      const request = validateRequest(value, routing);
      const data = await send(
        base,
        "POST",
        JSON.stringify({
          connection_id: connectionId,
          from: request.from,
          to: request.to,
          ...(webhook ? { webhook_url: webhook, webhook_url_method: "POST" } : {}),
        }),
        options,
        jsonHeaders,
      );
      // Dial always returns is_alive:false because dialing is asynchronous.
      return snapshot(ref(data), "queued");
    },
    async get(value, options) {
      const data = await send(callPath(value), "GET", undefined, options);
      const call = record(record(data).data);
      // is_alive alone cannot distinguish ringing, answered, failed or unestablished calls.
      return sameCall(
        value,
        snapshot(ref(data), call.is_alive === false && eventTime(call.end_time) ? "completed" : "unknown"),
      );
    },
    async hangup(value, options) {
      const data = record(
        record(await send(`${callPath(value)}/actions/hangup`, "POST", "{}", options, jsonHeaders)).data,
      );
      if (data.result !== "ok") throw new TelephonyError("invalid-response", "unknown");
      return { ref: { ...value }, acknowledged: true };
    },
    normalizeVerifiedEvent(value) {
      const data = record(record(value).data);
      const payload = record(data.payload);
      if (payload.connection_id !== undefined && payload.connection_id !== connectionId)
        throw new TelephonyError("invalid-input", "not-dispatched");
      const native =
        data.event_type === "call.initiated"
          ? "queued"
          : data.event_type === "call.answered"
            ? "active"
            : data.event_type === "call.hangup"
              ? "completed"
              : "unknown";
      return {
        ...snapshot(makeRef(id, routing.routeId, payload.call_control_id), native),
        eventId: data.id === undefined ? undefined : string(data.id, 200),
        occurredAt: eventTime(data.occurred_at),
      };
    },
  } satisfies OutboundCallProvider);
}
export interface VonageCallConfig extends TelephonyHttpConfig {
  answerUrl: string;
  eventUrl?: string;
  /** Official regional API origins may be selected by the host. */
  apiOrigin?:
    | "https://api.nexmo.com"
    | "https://api-us.vonage.com"
    | "https://api-eu.vonage.com"
    | "https://api-ap.vonage.com";
}
export function createVonageCallProvider(config: VonageCallConfig): OutboundCallProvider {
  const routing = route(config);
  const send = http(config);
  const id = "vonage";
  const answer = safeUrl(config.answerUrl);
  const event = config.eventUrl ? safeUrl(config.eventUrl) : undefined;
  const origin = config.apiOrigin ?? "https://api.nexmo.com";
  if (
    ![
      "https://api.nexmo.com",
      "https://api-us.vonage.com",
      "https://api-eu.vonage.com",
      "https://api-ap.vonage.com",
    ].includes(origin)
  )
    throw new TelephonyError("invalid-input", "not-dispatched");
  const base = `${origin}/v1/calls`;
  const parse = (value: unknown) => {
    const data = record(value);
    return snapshot(makeRef(id, routing.routeId, data.uuid), data.status);
  };
  const callPath = (value: CallReference) =>
    `${base}/${encodeURIComponent(validateRef(value, id, routing.routeId).callId)}`;
  return Object.freeze({
    id,
    routeId: routing.routeId,
    capabilities: Object.freeze({
      transport: "http",
      automaticCreateRetry: false,
      callbackVerification: "host",
      hangup: "call",
    }),
    async create(value, options) {
      const request = validateRequest(value, routing);
      return parse(
        await send(
          base,
          "POST",
          JSON.stringify({
            to: [{ type: "phone", number: request.to.slice(1) }],
            from: { type: "phone", number: request.from.slice(1) },
            answer_url: [answer],
            answer_method: "POST",
            ...(event ? { event_url: [event], event_method: "POST" } : {}),
          }),
          options,
          jsonHeaders,
        ),
      );
    },
    async get(value, options) {
      return sameCall(value, parse(await send(callPath(value), "GET", undefined, options)));
    },
    async hangup(value, options) {
      await send(callPath(value), "PUT", JSON.stringify({ action: "hangup" }), options, jsonHeaders);
      return { ref: { ...value }, acknowledged: true };
    },
    normalizeVerifiedEvent(value) {
      const data = record(value);
      return { ...parse(data), occurredAt: eventTime(data.timestamp) };
    },
  } satisfies OutboundCallProvider);
}
export interface ExotelCallConfig extends TelephonyHttpConfig {
  accountSid: string;
  region: "mumbai" | "singapore";
  /** AgentStream endpoint operated by the host. Media framing remains host-owned. */
  streamUrl: string;
  statusCallbackUrl?: string;
}
export function createExotelCallProvider(config: ExotelCallConfig): OutboundCallProvider {
  const routing = route(config);
  const send = http(config);
  const id = "exotel";
  if (!["mumbai", "singapore"].includes(config.region)) throw new TelephonyError("invalid-input", "not-dispatched");
  const origin = config.region === "mumbai" ? "https://api.in.exotel.com" : "https://api.exotel.com";
  const accountSid = config.accountSid;
  const account = segment(accountSid);
  const base = `${origin}/v1/Accounts/${account}/Calls`;
  const stream = safeUrl(config.streamUrl, "wss:");
  if (stream.length > 600) throw new TelephonyError("invalid-input", "not-dispatched");
  const callback = config.statusCallbackUrl ? safeUrl(config.statusCallbackUrl) : undefined;
  const parse = (value: unknown) => {
    const data = record(record(value).Call);
    return snapshot(makeRef(id, routing.routeId, data.Sid), data.Status);
  };
  const callPath = (value: CallReference) =>
    `${base}/${encodeURIComponent(validateRef(value, id, routing.routeId).callId)}`;
  return Object.freeze({
    id,
    routeId: routing.routeId,
    capabilities: Object.freeze({
      transport: "http",
      automaticCreateRetry: false,
      callbackVerification: "host",
      hangup: "active-legs",
    }),
    async create(value, options) {
      const request = validateRequest(value, routing);
      const form = new FormData();
      // Exotel From is the first dialed leg; CallerId is the owned ExoPhone.
      form.set("From", request.to);
      form.set("CallerId", request.from);
      form.set("StreamUrl", stream);
      form.set("StreamType", "bidirectional");
      if (callback) {
        form.set("StatusCallback", callback);
        for (const event of ["answered", "ringing", "terminal"]) form.append("StatusCallbackEvents[]", event);
      }
      return parse(await send(`${base}/connect`, "POST", form, options));
    },
    async get(value, options) {
      return sameCall(value, parse(await send(`${callPath(value)}.json`, "GET", undefined, options)));
    },
    async hangup(value, options) {
      const path = callPath(value);
      const current = await this.get(value, options);
      if (terminal(current.status)) return { ref: { ...value }, acknowledged: true };
      const data = record(await send(`${path}/ActiveLegs.json`, "GET", undefined, options));
      if (!Array.isArray(data.Legs) || !data.Legs.length || data.Legs.length > 16)
        throw new TelephonyError("unresolved", "not-dispatched");
      const legs = data.Legs.map((entry) => {
        const leg = record(entry);
        if (leg.CallSid !== value.callId || leg.AccountSid !== accountSid)
          throw new TelephonyError("invalid-response", "not-dispatched");
        return segment(string(leg.Sid, 200));
      });
      let dispatched = false;
      try {
        for (const leg of legs) {
          dispatched = true;
          const result = record(
            record(
              await send(
                `${path}/Legs/${leg}.json`,
                "PUT",
                new URLSearchParams({ Action: "hangup" }),
                options,
                formHeaders,
              ),
            ).legs,
          );
          if (result.LastAction !== "hangup" || result.CallSid !== value.callId)
            throw new TelephonyError("invalid-response", "unknown");
        }
      } catch (error) {
        if (dispatched) throw new TelephonyError("unresolved", "unknown");
        throw error;
      }
      return { ref: { ...value }, acknowledged: true };
    },
    normalizeVerifiedEvent(value) {
      const data = record(value);
      if (data.AccountSid !== undefined && data.AccountSid !== accountSid)
        throw new TelephonyError("invalid-input", "not-dispatched");
      return snapshot(makeRef(id, routing.routeId, data.CallSid), data.Status);
    },
  } satisfies OutboundCallProvider);
}
