/**
 * OpenAI Realtime REST helpers — ephemeral browser keys and WebRTC call creation.
 * https://developers.openai.com/api/docs/guides/realtime
 */

export interface ClientSecretOpts {
  apiKey?: string;
  signal?: AbortSignal;
  baseURL?: string;
  model?: string;
  /** Hashed end-user id for OpenAI safety enforcement. */
  safetyIdentifier?: string;
  expiresAfterSeconds?: number;
}

export interface ClientSecretResult {
  value: string;
  expiresAt?: number;
  raw: unknown;
}

export async function createRealtimeClientSecret(opts: ClientSecretOpts = {}): Promise<ClientSecretResult> {
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required to mint a Realtime client secret.");
  const root = (opts.baseURL ?? "https://api.openai.com").replace(/\/$/, "").replace(/^wss:/, "https:");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (opts.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = opts.safetyIdentifier;

  const body: Record<string, unknown> = {
    session: {
      type: "realtime",
      model: opts.model ?? "gpt-realtime-2.1",
    },
  };
  if (opts.expiresAfterSeconds !== undefined) {
    if (
      !Number.isSafeInteger(opts.expiresAfterSeconds) ||
      opts.expiresAfterSeconds < 10 ||
      opts.expiresAfterSeconds > 7200
    )
      throw new Error("Realtime client secret expiry must be 10–7200 seconds");
    body.expires_after = { anchor: "created_at", seconds: opts.expiresAfterSeconds };
  }

  const res = await fetch(`${root}/v1/realtime/client_secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    redirect: "error",
  });
  const raw = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(raw?.error?.message ?? `client_secrets failed (${res.status})`);
  }
  const value = raw?.client_secret?.value ?? raw?.value;
  if (typeof value !== "string" || !value) throw new Error("Realtime client secret response lacks a value");
  return {
    value,
    expiresAt: raw?.client_secret?.expires_at ?? raw?.expires_at,
    raw,
  };
}

export interface RealtimeCallOpts {
  apiKey?: string;
  signal?: AbortSignal;
  baseURL?: string;
  model?: string;
  /** @deprecated Unsupported by the Realtime create-call endpoint; SIP uses a separate lifecycle. */
  sipUri?: string;
  sdp?: string;
  safetyIdentifier?: string;
}

export async function createRealtimeCall(
  opts: RealtimeCallOpts = {},
): Promise<{ id: string; sdp: string; raw: unknown }> {
  opts.signal?.throwIfAborted();
  if (opts.sipUri !== undefined) throw new Error("Realtime create-call supports WebRTC SDP, not outbound SIP");
  if (!opts.sdp?.trim()) throw new Error("A WebRTC SDP offer is required");
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required to create a Realtime call.");
  const root = (opts.baseURL ?? "https://api.openai.com").replace(/\/$/, "").replace(/^wss:/, "https:");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (opts.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = opts.safetyIdentifier;
  const body = new FormData();
  body.set("sdp", opts.sdp);
  body.set("session", JSON.stringify({ type: "realtime", model: opts.model ?? "gpt-realtime-2.1" }));
  const endpoint = `${root}/v1/realtime/calls`;
  const res = await fetch(endpoint, { method: "POST", headers, body, signal: opts.signal, redirect: "error" });
  const sdp = await res.text();
  if (!res.ok) {
    let message = `realtime/calls failed (${res.status})`;
    try {
      message = JSON.parse(sdp)?.error?.message ?? message;
    } catch {
      /* Non-JSON errors retain the status. */
    }
    throw new Error(message);
  }
  const location = res.headers.get("Location");
  const callUrl = location ? new URL(location, endpoint) : undefined;
  const id = callUrl?.pathname.split("/").at(-1);
  if (!id || !sdp.trim()) throw new Error("Realtime create-call response lacks SDP or call Location");
  return { id, sdp, raw: sdp };
}
