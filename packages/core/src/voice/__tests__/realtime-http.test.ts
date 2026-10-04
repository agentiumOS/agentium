import { afterEach, expect, it, vi } from "vitest";
import { createRealtimeCall, createRealtimeClientSecret } from "../realtime-http.js";

afterEach(() => vi.unstubAllGlobals());
it("creates a WebRTC call with multipart SDP and reads the answer and Location", async () => {
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get("sdp")).toBe("v=0\r\noffer");
    expect(JSON.parse(init.body.get("session"))).toEqual({ type: "realtime", model: "explicit-model" });
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.redirect).toBe("error");
    return new Response("v=0\r\nanswer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_123" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(
    await createRealtimeCall({ apiKey: "test", sdp: "v=0\r\noffer", model: "explicit-model", signal }),
  ).toMatchObject({
    id: "rtc_123",
    sdp: "v=0\r\nanswer",
  });
  expect(fetcher.mock.calls[0][1].signal).toBe(signal);
});
it("rejects unsupported SIP creation and missing successful response fields", async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await expect(createRealtimeCall({ apiKey: "test", sipUri: "sip:callee@example.com" })).rejects.toThrow(/SIP/);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(createRealtimeClientSecret({ apiKey: "test" })).rejects.toThrow(/lacks a value/);
  await expect(createRealtimeCall({ apiKey: "test", sdp: "offer" })).rejects.toThrow(/Location/);
});
