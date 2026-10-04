import { describe, expect, it, vi } from "vitest";
import { A2AV1Client } from "../v1-client.js";

const card = {
  name: "fixture",
  description: "fixture",
  version: "1",
  supportedInterfaces: [{ url: "https://trusted.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};
function deferredDiscovery() {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    (_input: string | URL | Request, _options?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const client = new A2AV1Client({ url: "https://trusted.example", fetch });
  return { client, fetch, finish: () => finish(Response.json(card)) };
}
describe("A2A discovery cancellation isolation", () => {
  it.each(["send", "stream", "getTask", "cancelTask", "discover"] as const)(
    "cancels %s promptly without cancelling another discovery caller",
    async (method) => {
      const fixture = deferredDiscovery();
      const controller = new AbortController();
      const operation =
        method === "stream"
          ? fixture.client.stream("hello", { signal: controller.signal }).next()
          : method === "discover"
            ? fixture.client.discover({ signal: controller.signal })
            : fixture.client[method]("hello", { signal: controller.signal });
      const reason = new Error("caller stopped");
      const rejection = expect(operation).rejects.toBe(reason);
      await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledOnce());
      const other = fixture.client.discover();
      const networkSignal = fixture.fetch.mock.calls[0][1]?.signal;
      controller.abort(reason);
      await rejection;
      expect(networkSignal?.aborted).toBe(false);
      fixture.finish();
      expect((await other).name).toBe("fixture");
      expect((await fixture.client.discover()).name).toBe("fixture");
      expect(fixture.fetch).toHaveBeenCalledOnce();
    },
  );
  it("never starts discovery for an already aborted caller", async () => {
    const fixture = deferredDiscovery();
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.client.send("hello", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("preserves discovery errors and permits retry after failure", async () => {
    const failure = new Error("discovery failed");
    const fetch = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(Response.json(card));
    const client = new A2AV1Client({ url: "https://trusted.example", fetch });
    await expect(client.discover({ signal: new AbortController().signal })).rejects.toThrow(/discovery failed/);
    expect((await client.discover()).name).toBe("fixture");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
