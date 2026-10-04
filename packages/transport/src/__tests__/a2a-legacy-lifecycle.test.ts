import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createA2AServer } from "../a2a/a2a-server.js";

function fixture(agent: any, maxTasks = 1) {
  let handler!: (request: any, response: any) => Promise<void>;
  const app = {
    use: () => {},
    get: () => {},
    post: (_path: string, fn: typeof handler) => {
      handler = fn;
    },
  };
  createA2AServer(app, { agents: { test: agent }, maxTasks });
  const request = () => ({
    body: {
      jsonrpc: "2.0",
      id: "request",
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
    },
  });
  const response = () =>
    Object.assign(new EventEmitter(), {
      json: vi.fn(),
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      writableLength: 0,
    });
  return { handler, request, response };
}
const output = {
  text: "result",
  status: "error",
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};
it("rejects new work at active-task capacity, evicts terminal failures, and preserves failed status", async () => {
  let resolve!: (value: typeof output) => void;
  const run = vi.fn(
    async () =>
      new Promise<typeof output>((done) => {
        resolve = done;
      }),
  );
  const f = fixture({ name: "test", run });
  const firstResponse = f.response();
  const first = f.handler(f.request(), firstResponse);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  const overflow = f.response();
  await f.handler(f.request(), overflow);
  expect(overflow.json).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining("capacity") }) }),
  );
  expect(run).toHaveBeenCalledOnce();
  resolve(output);
  await first;
  expect(firstResponse.json).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({ status: expect.objectContaining({ state: "failed" }) }),
    }),
  );
  run.mockResolvedValueOnce(output);
  await f.handler(f.request(), f.response());
  expect(run).toHaveBeenCalledTimes(2);
});
it("aborts legacy streaming work when its response disconnects", async () => {
  let signal!: AbortSignal;
  const started = { ready: false };
  const stream = async function* (_input: string, opts: { signal: AbortSignal }) {
    signal = opts.signal;
    started.ready = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const f = fixture({ name: "test", stream });
  const req = f.request();
  req.body.method = "message/stream";
  const response = f.response();
  const work = f.handler(req, response);
  await vi.waitFor(() => expect(started.ready).toBe(true));
  response.emit("close");
  await work;
  expect(signal.aborted).toBe(true);
  expect(response.listenerCount("close")).toBe(0);
});
