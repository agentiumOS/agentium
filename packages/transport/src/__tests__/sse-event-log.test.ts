import { describe, expect, it } from "vitest";
import { formatSSEEvent, InMemoryEventLog } from "../sse-event-log.js";

describe("InMemoryEventLog", () => {
  it("assigns monotonic ids per run", () => {
    const log = new InMemoryEventLog();
    const a = log.record("r1", { payload: { type: "text", text: "a" } });
    const b = log.record("r1", { payload: { type: "text", text: "b" } });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it("returns events since a given id (Last-Event-ID replay)", () => {
    const log = new InMemoryEventLog();
    log.record("r1", { payload: 1 });
    log.record("r1", { payload: 2 });
    log.record("r1", { payload: 3 });

    const missed = log.since("r1", 1);
    expect(missed.map((e) => e.payload)).toEqual([2, 3]);
  });

  it("returns empty when client is already up to date", () => {
    const log = new InMemoryEventLog();
    log.record("r1", { payload: 1 });
    expect(log.since("r1", 5)).toEqual([]);
  });

  it("isolates runs from each other", () => {
    const log = new InMemoryEventLog();
    log.record("r1", { payload: "a" });
    log.record("r2", { payload: "b" });
    expect(log.all("r1").map((e) => e.payload)).toEqual(["a"]);
    expect(log.all("r2").map((e) => e.payload)).toEqual(["b"]);
  });

  it("evicts oldest events when maxEventsPerRun exceeded", () => {
    const log = new InMemoryEventLog({ maxEventsPerRun: 3 });
    for (let i = 1; i <= 5; i++) log.record("r1", { payload: i });
    const all = log.all("r1").map((e) => e.payload);
    expect(all).toEqual([3, 4, 5]);
  });

  it("drop() removes the buffer immediately", () => {
    const log = new InMemoryEventLog();
    log.record("r1", { payload: "a" });
    log.drop("r1");
    expect(log.all("r1")).toEqual([]);
  });
});

describe("formatSSEEvent", () => {
  it("renders id + data lines", () => {
    const out = formatSSEEvent({ id: 7, payload: { hello: "world" }, recordedAt: 0 });
    expect(out).toContain("id: 7");
    expect(out).toContain('data: {"hello":"world"}');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("renders event line when provided", () => {
    const out = formatSSEEvent({ id: 1, payload: "hi", event: "message", recordedAt: 0 });
    expect(out).toContain("event: message");
  });
});
