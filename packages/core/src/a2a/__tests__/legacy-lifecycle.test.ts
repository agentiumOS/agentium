import { afterEach, expect, it, vi } from "vitest";
import { A2ARemoteAgent } from "../a2a-remote-agent.js";
import { A2ARemoteTeam } from "../a2a-remote-team.js";
import { A2ARemoteWorkflow } from "../a2a-remote-workflow.js";

afterEach(() => vi.unstubAllGlobals());
it.each(["agent", "team", "workflow"])("%s forwards cancellation and refuses redirects", async (kind) => {
  const controller = new AbortController();
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.redirect).toBe("error");
    return await new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const config = { url: "https://fixture.test", timeoutMs: 10000 };
  const work =
    kind === "agent"
      ? new A2ARemoteAgent(config).run("hi", { signal: controller.signal })
      : kind === "team"
        ? new A2ARemoteTeam(config).run("hi", { signal: controller.signal })
        : new A2ARemoteWorkflow(config).run({}, { signal: controller.signal });
  const reason = new Error("caller stopped");
  controller.abort(reason);
  await expect(work).rejects.toBe(reason);
});
it.each(["agent", "team"])("%s closes its SSE body when the consumer stops early", async (kind) => {
  const cancel = vi.fn();
  const event =
    kind === "agent"
      ? { result: { status: { state: "working", message: { parts: [{ kind: "text", text: "first" }] } } } }
      : { type: "text", text: "first" };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data:${JSON.stringify(event)}\r\n\r\n`));
            },
            cancel,
          }),
        ),
    ),
  );
  const config = { url: "https://fixture.test" };
  const agent = kind === "agent" ? new A2ARemoteAgent(config) : new A2ARemoteTeam(config);
  for await (const chunk of agent.stream("hi")) {
    expect(chunk).toMatchObject({ type: "text", text: "first" });
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
});
it("preserves failed legacy task status and surfaces remote streaming failures", async () => {
  const task = { status: { state: "failed", message: { parts: [{ kind: "text", text: "failed" }] } } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      JSON.parse(init.body).method === "message/send"
        ? Response.json({ result: task })
        : new Response(`data: ${JSON.stringify({ result: task })}\n\n`),
    ),
  );
  const agent = new A2ARemoteAgent({ url: "https://fixture.test" });
  expect(await agent.run("hi")).toMatchObject({ status: "error" });
  await expect(agent.stream("hi").next()).rejects.toThrow(/failed/);
});
