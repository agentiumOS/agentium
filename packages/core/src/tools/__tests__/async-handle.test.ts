import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { createPollResultTool, defineAsyncTool } from "../async-handle.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("defineAsyncTool / createPollResultTool", () => {
  it("returns a handle immediately", async () => {
    const tool = defineAsyncTool({
      name: "slowFetch",
      description: "fetch url",
      parameters: z.object({ url: z.string() }),
      execute: async ({ url }) => `done: ${url}`,
    });
    const ctx = makeCtx();
    const result = await tool.execute({ url: "https://x.com" }, ctx);
    const parsed = JSON.parse(result as string);
    expect(parsed.handle).toMatch(/^ah:/);
    expect(parsed.status).toBe("pending");
  });

  it("pollResult eventually returns the resolved value", async () => {
    const tool = defineAsyncTool({
      name: "slow",
      description: "x",
      parameters: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "result-value";
      },
    });
    const poll = createPollResultTool();
    const ctx = makeCtx();

    const r1 = JSON.parse((await tool.execute({}, ctx)) as string);
    const r2 = JSON.parse((await poll.execute({ handle: r1.handle, waitMs: 500 }, ctx)) as string);
    expect(r2.status).toBe("done");
    expect(r2.result).toBe("result-value");
  });

  it("pollResult returns pending while still in flight", async () => {
    const tool = defineAsyncTool({
      name: "slow",
      description: "x",
      parameters: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 1_000));
        return "done";
      },
    });
    const poll = createPollResultTool();
    const ctx = makeCtx();

    const r1 = JSON.parse((await tool.execute({}, ctx)) as string);
    const r2 = JSON.parse((await poll.execute({ handle: r1.handle, waitMs: 10 }, ctx)) as string);
    expect(r2.status).toBe("pending");
  });

  it("pollResult returns error on rejection", async () => {
    const tool = defineAsyncTool({
      name: "broken",
      description: "x",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("nope");
      },
    });
    const poll = createPollResultTool();
    const ctx = makeCtx();

    const r1 = JSON.parse((await tool.execute({}, ctx)) as string);
    const r2 = JSON.parse((await poll.execute({ handle: r1.handle, waitMs: 200 }, ctx)) as string);
    expect(r2.status).toBe("error");
    expect(r2.error).toBe("nope");
  });

  it("pollResult returns not-found for unknown handle", async () => {
    const poll = createPollResultTool();
    const ctx = makeCtx();
    const r = JSON.parse((await poll.execute({ handle: "ah:unknown" }, ctx)) as string);
    expect(r.status).toBe("not-found");
  });
});
