import { describe, expect, it } from "vitest";
import { assertHostAllowed, isHostAllowed, PathSecurityError, safeJoin } from "../path-safety.js";

describe("safeJoin", () => {
  it("returns a path inside the base", () => {
    const result = safeJoin("/var/data", "users.json");
    expect(result).toBe("/var/data/users.json");
  });

  it("blocks ../ traversal", () => {
    expect(() => safeJoin("/var/data", "../../etc/passwd")).toThrow(PathSecurityError);
  });

  it("blocks absolute escapes", () => {
    expect(() => safeJoin("/var/data", "/etc/passwd")).toThrow(PathSecurityError);
  });

  it("blocks null bytes", () => {
    expect(() => safeJoin("/var/data", "ok\0.txt")).toThrow(/null byte/);
  });

  it("blocks control characters", () => {
    expect(() => safeJoin("/var/data", "x\u0001.txt")).toThrow(/control characters/);
  });

  it("allows nested subdirectories", () => {
    expect(safeJoin("/var/data", "a/b/c.txt")).toBe("/var/data/a/b/c.txt");
  });
});

describe("isHostAllowed / assertHostAllowed", () => {
  it("returns true when allowedHosts is undefined", () => {
    expect(isHostAllowed("https://anything.com/x")).toBe(true);
  });

  it("returns true when allowedHosts is empty", () => {
    expect(isHostAllowed("https://anything.com/x", [])).toBe(true);
  });

  it("matches exact host", () => {
    expect(isHostAllowed("https://example.com/x", ["example.com"])).toBe(true);
  });

  it("matches sub-domain", () => {
    expect(isHostAllowed("https://api.example.com/x", ["example.com"])).toBe(true);
  });

  it("rejects unrelated host", () => {
    expect(isHostAllowed("https://evil.com/", ["example.com"])).toBe(false);
  });

  it("does NOT match partial-string suffixes", () => {
    // notexample.com should NOT match example.com
    expect(isHostAllowed("https://notexample.com/", ["example.com"])).toBe(false);
  });

  it("assertHostAllowed throws for disallowed host", () => {
    expect(() => assertHostAllowed("https://evil.com/", ["example.com"])).toThrow(PathSecurityError);
  });

  it("assertHostAllowed accepts allowed host silently", () => {
    expect(() => assertHostAllowed("https://example.com/x", ["example.com"])).not.toThrow();
  });
});
