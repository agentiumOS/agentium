import { createServer, type RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { google, ollama } from "../registry.js";
import type { ProviderRequestControls } from "../request-controls.js";

// Ollama is optional in core. Exercise its documented fetch seam without adding
// an SDK dependency; Manifest's HTTP acceptance test uses the installed SDK.
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (filename: string | URL) => {
      const require = original.createRequire(filename);
      return Object.assign(
        (id: string) =>
          id === "ollama"
            ? {
                Ollama: class {
                  constructor(private readonly options: { host: string; fetch: typeof fetch }) {}
                  async chat(params: object) {
                    const response = await this.options.fetch(`${this.options.host}/api/chat`, {
                      method: "POST",
                      body: JSON.stringify(params),
                    });
                    if (!response.ok) throw Object.assign(new Error("busy"), { status: response.status });
                    return response.json();
                  }
                },
              }
            : require(id),
        require,
      );
    },
  };
});
async function server(listener: RequestListener) {
  const instance = createServer(listener);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
const factories = [
  {
    name: "Google",
    create: (url: string, controls: ProviderRequestControls) =>
      google("gemini-test", { apiKey: "test", baseURL: url, ...controls }),
  },
  {
    name: "Ollama",
    create: (url: string, controls: ProviderRequestControls) => ollama("test", { host: url, ...controls }),
  },
];
describe.each(factories)("$name request ownership", ({ create }) => {
  it.each(["generate", "stream"])(
    "makes exactly one physical HTTP request for %s when both retry owners are disabled",
    async (mode) => {
      let calls = 0;
      const fixture = await server((_request, response) => {
        calls++;
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":{"code":503,"message":"busy"}}');
      });
      try {
        const provider = create(fixture.url, { maxRetries: 0, sdkMaxRetries: 0 });
        await expect(
          mode === "stream"
            ? provider.stream([{ role: "user", content: "hello" }]).next()
            : provider.generate([{ role: "user", content: "hello" }]),
        ).rejects.toThrow();
        expect(calls).toBe(1);
        expect(provider.attemptVisibility).toBe("physical");
      } finally {
        await fixture.close();
      }
    },
  );
  it.each(["generate", "stream"])(
    "aborts the underlying %s request and preserves the host cancellation reason",
    async (mode) => {
      let started: (() => void) | undefined;
      let closed: (() => void) | undefined;
      const received = new Promise<void>((resolve) => {
        started = resolve;
      });
      const disconnected = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const fixture = await server((_request, response) => {
        started?.();
        response.on("close", () => closed?.());
      });
      try {
        const provider = create(fixture.url, { maxRetries: 0, sdkMaxRetries: 0 });
        const controller = new AbortController();
        const reason = new Error("host stopped");
        const pending =
          mode === "stream"
            ? provider.stream([{ role: "user", content: "hello" }], { signal: controller.signal }).next()
            : provider.generate([{ role: "user", content: "hello" }], { signal: controller.signal });
        const rejected = expect(pending).rejects.toBe(reason);
        await received;
        controller.abort(reason);
        await rejected;
        await disconnected;
      } finally {
        await fixture.close();
      }
    },
  );
  it("does not open an HTTP request after pre-cancellation", async () => {
    let calls = 0;
    const fixture = await server((_request, response) => {
      calls++;
      response.end("{}");
    });
    try {
      const provider = create(fixture.url, { maxRetries: 0, sdkMaxRetries: 0 });
      const controller = new AbortController();
      controller.abort(new Error("already stopped"));
      await expect(provider.generate([], { signal: controller.signal })).rejects.toThrow("already stopped");
      expect(calls).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
