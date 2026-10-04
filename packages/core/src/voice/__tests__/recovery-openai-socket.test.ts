import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { OpenAIRealtimeProvider } from "../providers/openai-realtime.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
async function fixture(onSession: (socket: WebSocket, event: unknown) => void) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  server.on("connection", (socket) => socket.on("message", (data) => onSession(socket, JSON.parse(data.toString()))));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Expected TCP fixture address");
  return new OpenAIRealtimeProvider("fixture", { apiKey: "test-only", baseURL: `ws://127.0.0.1:${address.port}` });
}

it("waits for OpenAI session configuration acknowledgement before reporting a usable connection", async () => {
  let acknowledge!: () => void;
  const received = vi.fn();
  const provider = await fixture((socket, event) => {
    received(event);
    acknowledge = () => socket.send(JSON.stringify({ type: "session.updated", session: { type: "realtime" } }));
  });
  let resolved = false;
  const pending = provider.connect({ instructions: "fixture" }).then((connection) => {
    resolved = true;
    return connection;
  });
  await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
  expect(received).toHaveBeenCalledWith(expect.objectContaining({ type: "session.update" }));
  expect(resolved).toBe(false);
  acknowledge();
  const connection = await pending;
  expect(connection.connectionState).toBe("open");
  await connection.close();
});

it("rejects server configuration errors and closes the rejected socket", async () => {
  let socket!: WebSocket;
  const provider = await fixture((connection) => {
    socket = connection;
    connection.send(JSON.stringify({ type: "error", error: { message: "fixture config rejected" } }));
  });
  await expect(provider.connect({})).rejects.toThrow(/fixture config rejected/);
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
});

it("rejects transport closure before setup instead of waiting for the connection timeout", async () => {
  const provider = await fixture((socket) => socket.close());
  await expect(provider.connect({})).rejects.toThrow(/closed before session setup/);
});

it("aborts a pending OpenAI setup and closes the actual local socket", async () => {
  let socket!: WebSocket;
  const provider = await fixture((connection) => {
    socket = connection;
  });
  const controller = new AbortController();
  const pending = provider.connect({ signal: controller.signal });
  const rejection = expect(pending).rejects.toThrow(/cancelled/);
  await vi.waitFor(() => expect(socket).toBeDefined());
  controller.abort();
  await rejection;
  await vi.waitFor(() => expect(socket.readyState).toBe(3));
});
