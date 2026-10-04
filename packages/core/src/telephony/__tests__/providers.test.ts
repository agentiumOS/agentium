import { describe, expect, it, vi } from "vitest";
import {
  createExotelCallProvider,
  createLiveKitSipCallProvider,
  createSignalWireCallProvider,
  createTelnyxCallProvider,
  createTwilioCallProvider,
  createVonageCallProvider,
  type OutboundCallProvider,
  TelephonyError,
  type TelephonyHttpConfig,
} from "../index.js";

const request = {
  intentId: "intent-1",
  identity: { tenantId: "tenant-a", userId: "user-a" },
  routeId: "support-v1",
  to: "+14155550101",
  from: "+14155550102",
};
function wire(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (!responses.length) throw new Error("unexpected provider request");
    const response = responses.shift();
    return response instanceof Response ? response : Response.json(response);
  });
  const config: TelephonyHttpConfig = {
    routeId: request.routeId,
    allowedFrom: [request.from],
    authorization: () => "Bearer fixture-secret",
    fetch: fetch as typeof globalThis.fetch,
  };
  return { calls, fetch, config };
}
const call = (providerId: string) => ({ providerId, routeId: request.routeId, callId: "call-1" });
describe("official HTTP call wire mappings", () => {
  it.each(["twilio", "signalwire"] as const)(
    "%s creates, reads, and cancels queued calls through the compatibility resource",
    async (id) => {
      const f = wire([
        { sid: "call-1", status: "queued" },
        { sid: "call-1", status: "ringing" },
        { sid: "call-1", status: "queued" },
        { sid: "call-1", status: "canceled" },
      ]);
      const config = {
        ...f.config,
        accountSid: "account-1",
        answerUrl: "https://host.example/answer",
        statusCallbackUrl: "https://host.example/status",
      };
      const provider =
        id === "twilio"
          ? createTwilioCallProvider(config)
          : createSignalWireCallProvider({ ...config, spaceUrl: "https://fixture.signalwire.com" });
      expect((await provider.create(request)).status).toBe("queued");
      expect((await provider.get(call(id))).status).toBe("ringing");
      expect(await provider.hangup(call(id))).toEqual({ ref: call(id), acknowledged: true });
      const first = f.calls[0];
      const body = first.init.body as URLSearchParams;
      expect(first.url).toBe(
        id === "twilio"
          ? "https://api.twilio.com/2010-04-01/Accounts/account-1/Calls.json"
          : "https://fixture.signalwire.com/api/laml/2010-04-01/Accounts/account-1/Calls",
      );
      expect(first.init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer fixture-secret" },
      });
      expect(Object.fromEntries(body)).toMatchObject({
        To: request.to,
        From: request.from,
        Url: config.answerUrl,
        Method: "POST",
      });
      expect(body.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
      expect(f.calls[3].init.method).toBe("POST");
      expect(String(f.calls[3].init.body)).toBe("Status=canceled");
      expect(
        provider.normalizeVerifiedEvent({ AccountSid: "account-1", CallSid: "call-1", CallStatus: "completed" }).status,
      ).toBe("completed");
      expect(() =>
        provider.normalizeVerifiedEvent({ AccountSid: "other", CallSid: "call-1", CallStatus: "completed" }),
      ).toThrow(TelephonyError);
    },
  );
  it("Twilio completes an active call and never deletes the call record", async () => {
    const f = wire([
      { sid: "call-1", status: "in-progress" },
      { sid: "call-1", status: "completed" },
    ]);
    const p = createTwilioCallProvider({ ...f.config, accountSid: "a", answerUrl: "https://host.example/answer" });
    await p.hangup(call("twilio"));
    expect(String(f.calls[1].init.body)).toBe("Status=completed");
    expect(f.calls.every(({ init }) => init.method !== "DELETE")).toBe(true);
  });
  it("Telnyx dial is asynchronous; false is_alive alone is never terminal evidence", async () => {
    const f = wire([
      { data: { call_control_id: "call-1", is_alive: false } },
      { data: { call_control_id: "call-1", is_alive: false } },
      { data: { result: "ok" } },
    ]);
    const p = createTelnyxCallProvider({
      ...f.config,
      connectionId: "connection-1",
      webhookUrl: "https://host.example/events",
    });
    expect((await p.create(request)).status).toBe("queued");
    expect((await p.get(call("telnyx"))).status).toBe("unknown");
    await p.hangup(call("telnyx"));
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      connection_id: "connection-1",
      from: request.from,
      to: request.to,
      webhook_url: "https://host.example/events",
      webhook_url_method: "POST",
    });
    expect(f.calls.map(({ url, init }) => [url, init.method])).toEqual([
      ["https://api.telnyx.com/v2/calls", "POST"],
      ["https://api.telnyx.com/v2/calls/call-1", "GET"],
      ["https://api.telnyx.com/v2/calls/call-1/actions/hangup", "POST"],
    ]);
    expect(
      p.normalizeVerifiedEvent({
        data: {
          id: "e1",
          event_type: "call.answered",
          payload: { call_control_id: "call-1", connection_id: "connection-1" },
        },
      }).status,
    ).toBe("active");
  });
  it("Vonage strips E164 + on phone endpoints, uses host answer URL and PUT hangup", async () => {
    const f = wire([
      { uuid: "call-1", status: "started" },
      { uuid: "call-1", status: "answered" },
      new Response(null, { status: 204 }),
    ]);
    const p = createVonageCallProvider({
      ...f.config,
      answerUrl: "https://host.example/ncco",
      eventUrl: "https://host.example/events",
    });
    await p.create(request);
    expect((await p.get(call("vonage"))).status).toBe("active");
    await p.hangup(call("vonage"));
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      to: [{ type: "phone", number: "14155550101" }],
      from: { type: "phone", number: "14155550102" },
      answer_url: ["https://host.example/ncco"],
      answer_method: "POST",
      event_url: ["https://host.example/events"],
      event_method: "POST",
    });
    expect(f.calls[2]).toMatchObject({
      url: "https://api.nexmo.com/v1/calls/call-1",
      init: { method: "PUT", body: '{"action":"hangup"}' },
    });
    expect(p.normalizeVerifiedEvent({ uuid: "call-1", status: "unanswered" }).status).toBe("no-answer");
  });
  it("Exotel dials From via AgentStream and hangs up the active legs of the scoped call", async () => {
    const f = wire([
      { Call: { Sid: "call-1", Status: "queued" } },
      { Call: { Sid: "call-1", Status: "in-progress" } },
      { Call: { Sid: "call-1", Status: "in-progress" } },
      { Legs: [{ Sid: "leg-1", CallSid: "call-1", AccountSid: "account-1" }] },
      { legs: { Sid: "leg-1", CallSid: "call-1", LastAction: "hangup", Status: "in-progress" } },
    ]);
    const p = createExotelCallProvider({
      ...f.config,
      accountSid: "account-1",
      region: "mumbai",
      streamUrl: "wss://host.example/media",
      statusCallbackUrl: "https://host.example/events",
    });
    await p.create(request);
    expect((await p.get(call("exotel"))).status).toBe("active");
    expect(await p.hangup(call("exotel"))).toMatchObject({ acknowledged: true });
    const form = f.calls[0].init.body as FormData;
    expect(Object.fromEntries(form)).toMatchObject({
      From: request.to,
      CallerId: request.from,
      StreamUrl: "wss://host.example/media",
      StreamType: "bidirectional",
    });
    expect(form.getAll("StatusCallbackEvents[]")).toEqual(["answered", "ringing", "terminal"]);
    expect(f.calls[0].url).toBe("https://api.in.exotel.com/v1/Accounts/account-1/Calls/connect");
    expect(f.calls[3].url).toContain("/Calls/call-1/ActiveLegs.json");
    expect(f.calls[4]).toMatchObject({
      url: "https://api.in.exotel.com/v1/Accounts/account-1/Calls/call-1/Legs/leg-1.json",
      init: { method: "PUT" },
    });
    expect(String(f.calls[4].init.body)).toBe("Action=hangup");
    expect(p.normalizeVerifiedEvent({ CallSid: "call-1", Status: "busy" }).status).toBe("busy");
  });
  it("Exotel rejects unrelated returned legs without sending a hangup", async () => {
    const f = wire([
      { Call: { Sid: "call-1", Status: "in-progress" } },
      { Legs: [{ Sid: "leg-1", CallSid: "other", AccountSid: "account-1" }] },
    ]);
    const p = createExotelCallProvider({
      ...f.config,
      accountSid: "account-1",
      region: "singapore",
      streamUrl: "wss://host.example/media",
    });
    await expect(p.hangup(call("exotel"))).rejects.toMatchObject({ code: "invalid-response" });
    expect(f.calls.every(({ init }) => init.method === "GET")).toBe(true);
  });
});
function httpProviders(f: ReturnType<typeof wire>): OutboundCallProvider[] {
  return [
    createTwilioCallProvider({ ...f.config, accountSid: "a", answerUrl: "https://host.example/answer" }),
    createSignalWireCallProvider({
      ...f.config,
      accountSid: "a",
      spaceUrl: "https://fixture.signalwire.com",
      answerUrl: "https://host.example/answer",
    }),
    createTelnyxCallProvider({ ...f.config, connectionId: "c" }),
    createVonageCallProvider({ ...f.config, answerUrl: "https://host.example/answer" }),
    createExotelCallProvider({ ...f.config, accountSid: "a", region: "mumbai", streamUrl: "wss://host.example/media" }),
  ];
}
describe("provider-neutral HTTP conformance", () => {
  it.each([0, 1, 2, 3, 4])("adapter %i rejects malformed input and forged route/caller before IO", async (index) => {
    const f = wire([]);
    const p = httpProviders(f)[index];
    for (const bad of [
      { ...request, to: "911" },
      { ...request, from: "+14155550199" },
      { ...request, routeId: "other" },
      { ...request, identity: { userId: "u", tenantId: "" } },
      { ...request, callbackUrl: "https://attacker.example" },
    ]) {
      await expect(p.create(bad)).rejects.toBeInstanceOf(TelephonyError);
    }
    await expect(p.get({ ...call(p.id), providerId: "other" })).rejects.toBeInstanceOf(TelephonyError);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 4])("adapter %i rejects a pre-aborted operation with zero dispatch", async (index) => {
    const f = wire([]);
    const p = httpProviders(f)[index];
    await expect(p.create(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      outcome: "not-dispatched",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 4])("adapter %i treats malformed successful creation as unknown", async (index) => {
    const f = wire([{}]);
    const p = httpProviders(f)[index];
    await expect(p.create(request)).rejects.toMatchObject({ code: "invalid-response", outcome: "unknown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("redacts network, credential resolver, and provider body errors", async () => {
    const f = wire([new Response("secret provider error", { status: 500 })]);
    const p = httpProviders(f)[0];
    await expect(p.create(request)).rejects.toMatchObject({
      message: "Telephony operation failed: provider-rejected (unknown)",
      httpStatus: 500,
    });
    const denied = createTelnyxCallProvider({
      ...f.config,
      connectionId: "c",
      authorization: () => {
        throw new Error("secret token");
      },
    });
    await expect(denied.create(request)).rejects.toMatchObject({
      message: "Telephony operation failed: provider-unavailable (not-dispatched)",
    });
  });
  it("bounds stalled fetch, stalled body, and oversized response without retry", async () => {
    const stalled = vi.fn(() => new Promise<Response>(() => {}));
    const p = createTelnyxCallProvider({
      routeId: request.routeId,
      allowedFrom: [request.from],
      connectionId: "c",
      authorization: () => "Bearer fake",
      fetch: stalled,
    });
    await expect(p.create(request, { timeoutMs: 5 })).rejects.toMatchObject({ outcome: "unknown" });
    expect(stalled).toHaveBeenCalledTimes(1);
    const f = wire([
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
    ]);
    await expect(httpProviders(f)[0].create(request, { timeoutMs: 5 })).rejects.toMatchObject({ outcome: "unknown" });
    const big = wire([new Response("x".repeat(70_000))]);
    await expect(httpProviders(big)[0].create(request)).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("distinguishes explicit rejection from an uncertain HTTP timeout", async () => {
    const f = wire([new Response(null, { status: 400 }), new Response(null, { status: 408 })]);
    const p = httpProviders(f)[0];
    await expect(p.create(request)).rejects.toMatchObject({ outcome: "rejected" });
    await expect(p.create(request)).rejects.toMatchObject({ outcome: "unknown" });
  });
});
describe("LiveKit SIP structural SDK mapping", () => {
  it("uses configured trunk/room, checks participant binding, removes only that participant", async () => {
    const createSipParticipant = vi.fn(
      async (_trunk: string, _number: string, roomName: string, options: { participantIdentity: string }) => ({
        roomName,
        participantIdentity: options.participantIdentity,
        sipCallId: "sip-call-1",
      }),
    );
    let identity = "";
    const getParticipant = vi.fn(async () => ({
      identity,
      attributes: { "sip.callID": "sip-call-1", "sip.callStatus": "active" },
    }));
    const removeParticipant = vi.fn(async () => {});
    const p = createLiveKitSipCallProvider({
      routeId: request.routeId,
      allowedFrom: [request.from],
      trunkId: "ST_fixture",
      roomName: "host-room",
      sip: { createSipParticipant },
      rooms: { getParticipant, removeParticipant },
    });
    const created = await p.create(request);
    identity = created.ref.participantIdentity ?? "";
    expect(createSipParticipant).toHaveBeenCalledWith("ST_fixture", request.to, "host-room", {
      participantIdentity: expect.stringMatching(/^call-[a-f0-9]{64}$/),
      fromNumber: request.from,
      waitUntilAnswered: false,
      hidePhoneNumber: true,
    });
    expect((await p.get(created.ref)).status).toBe("active");
    await p.hangup(created.ref);
    expect(removeParticipant).toHaveBeenCalledWith("host-room", identity);
    expect(
      p.normalizeVerifiedEvent({
        event: "participant_left",
        room: { name: "host-room" },
        participant: { identity, attributes: { "sip.callID": "sip-call-1", "sip.trunkID": "ST_fixture" } },
      }).status,
    ).toBe("completed");
    await expect(p.get({ ...created.ref, roomName: "other-room" })).rejects.toBeInstanceOf(TelephonyError);
    getParticipant.mockResolvedValueOnce({
      identity,
      attributes: { "sip.callID": "replacement", "sip.callStatus": "active" },
    });
    await expect(p.hangup(created.ref)).rejects.toBeInstanceOf(TelephonyError);
    expect(removeParticipant).toHaveBeenCalledTimes(1);
  });
  it("observes cancellation and late SDK failure without asserting remote cancellation", async () => {
    let reject!: (value: unknown) => void;
    const createSipParticipant = vi.fn(
      () =>
        new Promise<never>((_, fail) => {
          reject = fail;
        }),
    );
    const p = createLiveKitSipCallProvider({
      routeId: request.routeId,
      allowedFrom: [request.from],
      trunkId: "ST_fixture",
      roomName: "host-room",
      sip: { createSipParticipant },
      rooms: { getParticipant: vi.fn(), removeParticipant: vi.fn() },
    });
    await expect(p.create(request, { timeoutMs: 5 })).rejects.toMatchObject({ outcome: "unknown" });
    reject(new Error("secret SDK error"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(createSipParticipant).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a LiveKit create when aborted before its deferred SDK invocation", async () => {
    const createSipParticipant = vi.fn(
      async (_trunk: string, _number: string, roomName: string, options: { participantIdentity: string }) => ({
        roomName,
        participantIdentity: options.participantIdentity,
        sipCallId: "sip-call-1",
      }),
    );
    const provider = createLiveKitSipCallProvider({
      routeId: request.routeId,
      allowedFrom: [request.from],
      trunkId: "ST_fixture",
      roomName: "host-room",
      sip: { createSipParticipant },
      rooms: { getParticipant: vi.fn(), removeParticipant: vi.fn() },
    });
    const controller = new AbortController();
    const pending = provider.create(request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted", outcome: "not-dispatched" });
    expect(createSipParticipant).not.toHaveBeenCalled();
  });
});
