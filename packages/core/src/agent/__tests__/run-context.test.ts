import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import { RunContext } from "../run-context.js";

describe("RunContext", () => {
  it("generates a runId if not provided", () => {
    const ctx = new RunContext({ sessionId: "s1", eventBus: new EventBus() });
    expect(ctx.runId).toBeTruthy();
    expect(typeof ctx.runId).toBe("string");
  });

  it("uses provided runId", () => {
    const ctx = new RunContext({
      sessionId: "s1",
      eventBus: new EventBus(),
      runId: "custom-id",
    });
    expect(ctx.runId).toBe("custom-id");
  });

  it("getState / setState round-trips values", () => {
    const ctx = new RunContext({ sessionId: "s1", eventBus: new EventBus() });
    ctx.setState("count", 42);
    expect(ctx.getState<number>("count")).toBe(42);
  });

  it("getState returns undefined for missing keys", () => {
    const ctx = new RunContext({ sessionId: "s1", eventBus: new EventBus() });
    expect(ctx.getState("missing")).toBeUndefined();
  });

  it("preserves metadata", () => {
    const ctx = new RunContext({
      sessionId: "s1",
      eventBus: new EventBus(),
      metadata: { foo: "bar" },
    });
    expect(ctx.metadata).toEqual({ foo: "bar" });
  });
  it("retains an immutable execution mode outside mutable state and metadata", () => {
    const ctx = new RunContext({ sessionId: "s1", eventBus: new EventBus(), runMode: "plan" });
    ctx.setState("runMode", "execute");
    ctx.metadata.runMode = "execute";
    expect(() => Object.assign(ctx, { runMode: "execute" })).toThrow();
    expect(ctx.runMode).toBe("plan");
    expect(new RunContext({ sessionId: "s2", eventBus: new EventBus() }).runMode).toBe("execute");
  });
});
