import { randomUUID } from "node:crypto";

/** A2A 1.0 JSON parts. Wire parts stay intact, including data and media. */
export type A2AV1Part = ({ text: string } | { data: unknown } | { raw: string } | { url: string }) & {
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
};
export interface A2AV1Message {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2AV1Part[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}
export type A2AV1State =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_AUTH_REQUIRED";
export interface A2AV1Task {
  id: string;
  contextId: string;
  status: { state: A2AV1State; message?: A2AV1Message; timestamp?: string };
  history?: A2AV1Message[];
  artifacts?: Array<{ artifactId: string; parts: A2AV1Part[]; name?: string; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}
export interface A2AV1Card {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string; tenant?: string }>;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean };
  [key: string]: unknown;
}
export type A2AV1StreamEvent =
  | { task: A2AV1Task }
  | { message: A2AV1Message }
  | {
      statusUpdate: { taskId: string; contextId: string; status: A2AV1Task["status"] };
    }
  | {
      artifactUpdate: {
        taskId: string;
        contextId: string;
        artifact: NonNullable<A2AV1Task["artifacts"]>[number];
        append?: boolean;
        lastChunk?: boolean;
      };
    };
export interface A2AV1ClientConfig {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export interface A2AV1CallOptions {
  signal?: AbortSignal;
  tenant?: string;
}

/** Cancel only this caller's wait. The cached discovery continues for other callers. */
function waitForDiscovery<T>(discovery: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return discovery;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    discovery.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Optional official-SDK adapter; importing core never loads the A2A SDK.
 * Credentials are restricted to the configured origin, including discovery. */
export class A2AV1Client {
  private readonly config: A2AV1ClientConfig;
  private connection?: Promise<import("@a2a-js/sdk/client").Client>;
  constructor(config: A2AV1ClientConfig) {
    const url = new URL(config.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("A2A requires an HTTP(S) URL without credentials");
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0))
      throw new Error("A2A timeout must be positive");
    this.config = { ...config, headers: { ...config.headers } };
  }
  private async client(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.connection) {
      this.connection = (async () => {
        const { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } = await import("@a2a-js/sdk/client");
        const origin = new URL(this.config.url).origin;
        const fetchImpl: typeof fetch = async (input, options) => {
          const target = new URL(input instanceof Request ? input.url : String(input));
          if (target.origin !== origin || target.username || target.password)
            throw new Error("A2A discovery selected an unapproved origin");
          const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined));
          for (const [key, value] of Object.entries(this.config.headers ?? {})) headers.set(key, value);
          const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 60_000);
          const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
          return (this.config.fetch ?? fetch)(input, {
            ...options,
            headers,
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
        };
        return new ClientFactory({
          transports: [new JsonRpcTransportFactory({ fetchImpl })],
          cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
        }).createFromUrl(this.config.url);
      })();
      this.connection.catch(() => {
        this.connection = undefined;
      });
    }
    return waitForDiscovery(this.connection, signal);
  }
  async discover(options?: Pick<A2AV1CallOptions, "signal">): Promise<A2AV1Card> {
    options?.signal?.throwIfAborted();
    const sdk = await import("@a2a-js/sdk");
    return sdk.AgentCard.toJSON(await (await this.client(options?.signal)).getAgentCard()) as A2AV1Card;
  }
  async send(message: A2AV1Message | string, options?: A2AV1CallOptions): Promise<A2AV1Task | A2AV1Message> {
    options?.signal?.throwIfAborted();
    const sdk = await import("@a2a-js/sdk");
    const request = sdk.SendMessageRequest.fromJSON({
      message:
        typeof message === "string"
          ? { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: message }] }
          : message,
      tenant: options?.tenant,
    });
    const response = await (await this.client(options?.signal)).sendMessage(request, { signal: options?.signal });
    return ("id" in response ? sdk.Task.toJSON(response) : sdk.Message.toJSON(response)) as A2AV1Task | A2AV1Message;
  }
  async *stream(message: A2AV1Message | string, options?: A2AV1CallOptions): AsyncGenerator<A2AV1StreamEvent> {
    options?.signal?.throwIfAborted();
    const sdk = await import("@a2a-js/sdk");
    const request = sdk.SendMessageRequest.fromJSON({
      message:
        typeof message === "string"
          ? { messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: message }] }
          : message,
      tenant: options?.tenant,
    });
    for await (const event of (await this.client(options?.signal)).sendMessageStream(request, {
      signal: options?.signal,
    }))
      yield sdk.StreamResponse.toJSON(event) as A2AV1StreamEvent;
  }
  async getTask(id: string, options?: A2AV1CallOptions): Promise<A2AV1Task> {
    options?.signal?.throwIfAborted();
    const sdk = await import("@a2a-js/sdk");
    return sdk.Task.toJSON(
      await (await this.client(options?.signal)).getTask(sdk.GetTaskRequest.fromJSON({ id, tenant: options?.tenant }), {
        signal: options?.signal,
      }),
    ) as A2AV1Task;
  }
  async cancelTask(id: string, options?: A2AV1CallOptions): Promise<A2AV1Task> {
    options?.signal?.throwIfAborted();
    const sdk = await import("@a2a-js/sdk");
    return sdk.Task.toJSON(
      await (await this.client(options?.signal)).cancelTask(
        sdk.CancelTaskRequest.fromJSON({ id, tenant: options?.tenant }),
        {
          signal: options?.signal,
        },
      ),
    ) as A2AV1Task;
  }
}
