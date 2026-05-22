import { describe, expect, it } from "vitest";
import { DrainController, RunDrainedError } from "../errors.js";

describe("DrainController", () => {
  it("starts undrained", () => {
    const dc = new DrainController();
    expect(dc.drained).toBe(false);
  });

  it("flips drained after requestDrain", () => {
    const dc = new DrainController();
    dc.requestDrain();
    expect(dc.drained).toBe(true);
  });

  it("requestDrain is idempotent", () => {
    const dc = new DrainController();
    dc.requestDrain();
    dc.requestDrain();
    expect(dc.drained).toBe(true);
  });

  it("waitForDrain resolves once requestDrain is called", async () => {
    const dc = new DrainController();
    const promise = dc.waitForDrain();
    setTimeout(() => dc.requestDrain(), 5);
    await expect(promise).resolves.toBeUndefined();
  });

  it("waitForDrain resolves immediately if already drained", async () => {
    const dc = new DrainController();
    dc.requestDrain();
    await expect(dc.waitForDrain()).resolves.toBeUndefined();
  });
});

describe("RunDrainedError", () => {
  it("carries the runId and a default message", () => {
    const err = new RunDrainedError("run-123");
    expect(err.runId).toBe("run-123");
    expect(err.message).toContain("drained");
    expect(err.name).toBe("RunDrainedError");
  });

  it("accepts a custom message", () => {
    const err = new RunDrainedError("run-1", "stop now");
    expect(err.message).toBe("stop now");
  });
});
