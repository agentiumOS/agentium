import { describe, expect, it } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { getArtifact } from "../artifact-store.js";
import { createArtifactTools } from "../artifact-tools.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("createArtifactTools", () => {
  it("returns three tools: storeArtifact, getArtifact, listArtifacts", () => {
    const tools = createArtifactTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["getArtifact", "listArtifacts", "storeArtifact"]);
  });

  it("storeArtifact saves and returns pointer JSON", async () => {
    const tools = createArtifactTools();
    const store = tools.find((t) => t.name === "storeArtifact")!;
    const ctx = makeCtx();
    const result = await store.execute({ name: "logs", value: "big log content" }, ctx);
    const parsed = JSON.parse(result as string);
    expect(parsed.pointer).toMatch(/^art:/);
    expect(parsed.preview).toBe("big log content");
    expect(getArtifact(ctx, "logs")?.value).toBe("big log content");
  });

  it("getArtifact retrieves stored value", async () => {
    const tools = createArtifactTools();
    const store = tools.find((t) => t.name === "storeArtifact")!;
    const get = tools.find((t) => t.name === "getArtifact")!;
    const ctx = makeCtx();
    await store.execute({ name: "logs", value: "abc xyz" }, ctx);
    const out = await get.execute({ pointerOrName: "logs" }, ctx);
    expect(out).toBe("abc xyz");
  });

  it("getArtifact returns not-found message for unknown name", async () => {
    const tools = createArtifactTools();
    const get = tools.find((t) => t.name === "getArtifact")!;
    const ctx = makeCtx();
    const out = await get.execute({ pointerOrName: "nope" }, ctx);
    expect(out as string).toContain("no artifact found");
  });

  it("listArtifacts returns JSON list", async () => {
    const tools = createArtifactTools();
    const store = tools.find((t) => t.name === "storeArtifact")!;
    const list = tools.find((t) => t.name === "listArtifacts")!;
    const ctx = makeCtx();
    await store.execute({ name: "a", value: "one" }, ctx);
    await store.execute({ name: "b", value: "two" }, ctx);
    const out = await list.execute({}, ctx);
    const items = JSON.parse(out as string);
    expect(items).toHaveLength(2);
    expect(items.map((i: any) => i.name).sort()).toEqual(["a", "b"]);
  });
});
