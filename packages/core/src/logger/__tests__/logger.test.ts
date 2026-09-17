import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../logger.js";

describe("Logger", () => {
  const lines: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    lines.length = 0;
  });

  function capture(): Logger {
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      lines.push(String(msg ?? ""));
    });
    return new Logger({ level: "debug", color: false, prefix: "test" });
  }

  it("pretty-prints tool args instead of truncating at 200 chars", () => {
    const logger = capture();
    const args = {
      query: "find all delayed shipments for acme",
      filters: { status: ["in_transit", "exception"], since: "2026-01-01" },
      limit: 50,
    };
    logger.toolCall("search_orders", args);
    const joined = lines.join("\n");
    expect(joined).toContain("search_orders");
    expect(joined).toContain('"in_transit"');
    expect(joined).not.toContain("…");
    expect(joined).toContain("→");
  });

  it("pretty-prints JSON tool results instead of slicing mid-object", () => {
    const logger = capture();
    const result = JSON.stringify({
      orders: Array.from({ length: 8 }, (_, i) => ({ id: `ORD-${i}`, city: "Mumbai" })),
      total: 8,
    });
    logger.toolResult("search_orders", result);
    const joined = lines.join("\n");
    expect(joined).toContain("ORD-7");
    expect(joined).toContain('"total": 8');
    expect(joined).not.toMatch(/…$/m);
  });

  it("notes leftover chars instead of a bare ellipsis when over the cap", () => {
    const logger = new Logger({ level: "debug", color: false, maxPayloadChars: 80 });
    const text = logger.formatPayload({ a: "x".repeat(200) });
    expect(text).toMatch(/more chars\)/);
    expect(text.startsWith("{")).toBe(true);
  });

  it("prints objects on debug() instead of [object Object]", () => {
    const logger = capture();
    logger.debug("hit", { city: "Tokyo", ok: true });
    expect(lines.join(" ")).toContain("Tokyo");
    expect(lines.join(" ")).not.toContain("[object Object]");
  });
});
