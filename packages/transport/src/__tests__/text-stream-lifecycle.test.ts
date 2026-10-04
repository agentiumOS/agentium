import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createAgentRouter } from "../express/router-factory.js";
import { BoundedSSEWriter } from "../text-stream.js";

async function host(agent: any, textStream: any = {}, target = "agents", registry = false) {
  const app = express();
  app.use(express.json());
  const entries = { [target]: { fixture: agent } };
  const fakeRegistry = { getAgent: () => agent, getTeam: () => agent, getWorkflow: () => agent };
  app.use(
    createAgentRouter({
      security: { mode: "local" },
      ...(!registry ? entries : {}),
      registry: registry ? (fakeRegistry as any) : false,
      textStream,
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${target}/fixture`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("bounded connection-owned text responses", () => {
  it("waits for drain without producing another frame and releases all listeners", async () => {
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      write: vi.fn(() => false),
    });
    const abort = new AbortController();
    const writer = new BoundedSSEWriter(res as any, abort.signal, {
      writeTimeoutMs: 20,
      maxFrameBytes: 20,
      maxBufferedBytes: 20,
    });
    const pending = writer.write("data: test\n\n");
    expect(res.listenerCount("drain")).toBe(1);
    res.emit("drain");
    await pending;
    expect(res.eventNames()).toEqual([]);
    await expect(writer.write("x".repeat(21))).rejects.toThrow(/byte limit/);
    const timeout = writer.write("x");
    await expect(timeout).rejects.toThrow(/deadline/);
    expect(res.eventNames()).toEqual([]);
    const canceled = writer.write("x");
    abort.abort(new Error("stop"));
    await expect(canceled).rejects.toThrow("stop");
    expect(res.eventNames()).toEqual([]);
  });

  for (const target of ["agents", "teams"] as const)
    for (const registry of [false, true]) {
      it(`disconnect aborts and settles ${target} ${registry ? "registry" : "map"} iterator`, async () => {
        let signal: AbortSignal | undefined;
        let closed = false;
        let produced = 0;
        const fixture = await host(
          {
            async *stream(_input: string, opts: any) {
              signal = opts.signal;
              try {
                produced++;
                yield { type: "text", text: "first" };
                await new Promise<void>((resolve) =>
                  opts.signal.addEventListener("abort", () => resolve(), { once: true }),
                );
                produced++;
                yield { type: "text", text: "late" };
              } finally {
                closed = true;
              }
            },
          },
          {},
          target,
          registry,
        );
        try {
          await new Promise<void>((resolve, reject) => {
            const req = request(
              `${fixture.url}/stream`,
              { method: "POST", headers: { "content-type": "application/json" } },
              (res) => {
                res.once("data", () => {
                  res.destroy();
                  resolve();
                });
              },
            );
            req.on("error", reject);
            req.end(JSON.stringify({ input: "hi" }));
          });
          await vi.waitFor(() => expect(closed).toBe(true));
          expect(signal?.aborted).toBe(true);
          expect(produced).toBe(2);
        } finally {
          await fixture.close();
        }
      });
    }

  it("bounds a real paused HTTP reader and closes its producer after the write deadline", async () => {
    let count = 0;
    let closed = false;
    const fixture = await host(
      {
        async *stream() {
          try {
            while (true) {
              count++;
              yield { type: "text", text: "x".repeat(32 * 1024) };
            }
          } finally {
            closed = true;
          }
        },
      },
      { maxFrameBytes: 64 * 1024, maxBufferedBytes: 64 * 1024, writeTimeoutMs: 30 },
    );
    let response: any;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          `${fixture.url}/stream`,
          { method: "POST", headers: { "content-type": "application/json" } },
          (res) => {
            response = res;
            res.pause();
            resolve();
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ input: "hi" }));
      });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
      expect(count).toBeLessThan(1000);
    } finally {
      response?.destroy();
      await fixture.close();
    }
  });

  it("rejects an oversized frame, settles cleanup, and sends one error terminal", async () => {
    let closed = false;
    const fixture = await host(
      {
        async *stream() {
          try {
            yield { text: "x".repeat(1000) };
          } finally {
            closed = true;
          }
        },
      },
      { maxFrameBytes: 128 },
    );
    try {
      const res = await fetch(`${fixture.url}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      const data = await res.text();
      expect(closed).toBe(true);
      expect(data.match(/"type":"error"/g)).toHaveLength(1);
      expect(data).not.toContain("[DONE]");
    } finally {
      await fixture.close();
    }
  });

  for (const target of ["agents", "teams", "workflows"])
    it(`disconnect aborts ${target} run responses`, async () => {
      let signal: AbortSignal | undefined;
      let settled = false;
      const fixture = await host(
        {
          run: async (...args: any[]) => {
            signal = args.at(-1).signal;
            await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
            settled = true;
            return { text: "late" };
          },
        },
        {},
        target,
      );
      try {
        const req = request(`${fixture.url}/run`, { method: "POST", headers: { "content-type": "application/json" } });
        req.on("error", () => {});
        req.end(JSON.stringify({ input: "hi" }));
        await vi.waitFor(() => expect(signal).toBeDefined());
        req.destroy();
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(signal?.aborted).toBe(true);
      } finally {
        await fixture.close();
      }
    });
});
