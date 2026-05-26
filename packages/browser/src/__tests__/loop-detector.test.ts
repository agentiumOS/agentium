import { describe, expect, it } from "vitest";
import { LoopDetector, fnvHash, normalizeAction } from "../loop-detector.js";

describe("normalizeAction", () => {
  it("collapses different descriptions for the same indexed click", () => {
    const a = normalizeAction({ action: "click", index: 7, description: "the Cheapest tab" });
    const b = normalizeAction({ action: "click", index: 7, description: "Cheapest" });
    expect(a).toBe(b);
  });

  it("keeps different indices distinct", () => {
    const a = normalizeAction({ action: "click", index: 7, description: "X" });
    const b = normalizeAction({ action: "click", index: 9, description: "X" });
    expect(a).not.toBe(b);
  });

  it("buckets nearby coordinate clicks together", () => {
    const a = normalizeAction({ action: "click", x: 640, y: 300, description: "X" });
    const b = normalizeAction({ action: "click", x: 642, y: 304, description: "X" });
    expect(a).toBe(b);
  });

  it("buckets wait durations into 1s bands", () => {
    expect(normalizeAction({ action: "wait", ms: 1100 })).toBe(
      normalizeAction({ action: "wait", ms: 1400 }),
    );
    expect(normalizeAction({ action: "wait", ms: 1100 })).not.toBe(
      normalizeAction({ action: "wait", ms: 3000 }),
    );
  });
});

describe("LoopDetector — actions", () => {
  it("returns 'none' until the warn threshold is reached", () => {
    const ld = new LoopDetector({ actionThresholds: { warn: 3, escalate: 5, abort: 7 } });
    for (let i = 0; i < 2; i++) {
      const r = ld.recordAction({ action: "click", index: 1 });
      expect(r.severity).toBe("none");
    }
    expect(ld.recordAction({ action: "click", index: 1 }).severity).toBe("warn");
  });

  it("escalates and then aborts", () => {
    const ld = new LoopDetector({ actionThresholds: { warn: 3, escalate: 5, abort: 7 } });
    const sev: string[] = [];
    for (let i = 0; i < 7; i++) {
      sev.push(ld.recordAction({ action: "click", index: 1 }).severity);
    }
    expect(sev).toEqual(["none", "none", "warn", "warn", "escalate", "escalate", "abort"]);
  });

  it("resets when actions diverge", () => {
    const ld = new LoopDetector({ actionThresholds: { warn: 3, escalate: 5, abort: 7 } });
    ld.recordAction({ action: "click", index: 1 });
    ld.recordAction({ action: "click", index: 1 });
    ld.recordAction({ action: "click", index: 2 });
    // The "click index 1" count is now 2 again (the index-2 click is the most recent).
    expect(ld.recordAction({ action: "click", index: 1 }).severity).toBe("warn");
    // Note: the rolling window keeps both, so this should be 3 of index 1.
  });
});

describe("LoopDetector — pages", () => {
  it("counts consecutive identical fingerprints", () => {
    const ld = new LoopDetector({ pageThresholds: { warn: 3, escalate: 5, abort: 7 } });
    const fp = { url: "https://x", interactiveCount: 10, textHash: 42 };
    const sev: string[] = [];
    for (let i = 0; i < 7; i++) sev.push(ld.recordPage(fp).severity);
    expect(sev).toEqual(["none", "none", "warn", "warn", "escalate", "escalate", "abort"]);
  });

  it("resets on a different page", () => {
    const ld = new LoopDetector({ pageThresholds: { warn: 3, escalate: 5, abort: 7 } });
    const a = { url: "https://x", interactiveCount: 10, textHash: 42 };
    const b = { url: "https://y", interactiveCount: 12, textHash: 7 };
    ld.recordPage(a);
    ld.recordPage(a);
    ld.recordPage(a); // stagnantCount=3 → "warn"
    ld.recordPage(b); // reset
    expect(ld.recordPage(b).severity).toBe("none");
  });
});

describe("LoopDetector.combine", () => {
  it("returns the more severe of two advices", () => {
    expect(LoopDetector.combine({ severity: "warn" }, { severity: "abort" }).severity).toBe("abort");
    expect(LoopDetector.combine({ severity: "none" }, { severity: "warn" }).severity).toBe("warn");
  });
});

describe("fnvHash", () => {
  it("produces a stable number for a string", () => {
    expect(fnvHash("hello")).toBe(fnvHash("hello"));
    expect(fnvHash("hello")).not.toBe(fnvHash("hella"));
  });
});
