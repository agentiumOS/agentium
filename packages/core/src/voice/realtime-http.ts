/**
 * OpenAI Realtime REST helpers — ephemeral browser keys and SIP/WebRTC calls.
 * https://developers.openai.com/api/docs/guides/realtime
 */

export interface ClientSecretOpts {
  apiKey?: string;
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
  if (opts.expiresAfterSeconds) body.expires_after = { seconds: opts.expiresAfterSeconds };

  const res = await fetch(`${root}/v1/realtime/client_secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(raw?.error?.message ?? `client_secrets failed (${res.status})`);
  }
  return {
    value: raw?.client_secret?.value ?? raw?.value ?? "",
    expiresAt: raw?.client_secret?.expires_at ?? raw?.expires_at,
    raw,
  };
}

export interface RealtimeCallOpts {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** SIP URI, e.g. `sip:+15551234567@sip.example.com`. */
  sipUri?: string;
  sdp?: string;
  safetyIdentifier?: string;
}

export async function createRealtimeCall(opts: RealtimeCallOpts = {}): Promise<{ id: string; raw: unknown }> {
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required to create a Realtime call.");
  const root = (opts.baseURL ?? "https://api.openai.com").replace(/\/$/, "").replace(/^wss:/, "https:");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (opts.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = opts.safetyIdentifier;

  const body: Record<string, unknown> = {
    session: { type: "realtime", model: opts.model ?? "gpt-realtime-2.1" },
  };
  if (opts.sipUri) body.sip = { uri: opts.sipUri };
  if (opts.sdp) body.sdp = opts.sdp;

  const res = await fetch(`${root}/v1/realtime/calls`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(raw?.error?.message ?? `realtime/calls failed (${res.status})`);
  }
  return { id: raw?.id ?? raw?.call_id ?? "", raw };
}
