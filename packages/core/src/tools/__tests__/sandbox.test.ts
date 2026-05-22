import { describe, expect, it } from "vitest";
import { resolveSandboxConfig } from "../sandbox.js";

describe("resolveSandboxConfig", () => {
  it("returns null when neither tool nor agent has sandbox", () => {
    expect(resolveSandboxConfig(undefined, undefined)).toBeNull();
  });

  it("returns config from tool-level sandbox: true", () => {
    const result = resolveSandboxConfig(true, undefined);
    expect(result).toEqual({ enabled: true });
  });

  it("returns config from agent-level sandbox: true", () => {
    const result = resolveSandboxConfig(undefined, true);
    expect(result).toEqual({ enabled: true });
  });

  it("tool-level sandbox: false overrides agent-level", () => {
    const result = resolveSandboxConfig(false, { timeout: 5000 });
    expect(result).toBeNull();
  });

  it("tool-level config takes precedence over agent-level", () => {
    const result = resolveSandboxConfig({ timeout: 3000 }, { timeout: 10000 });
    expect(result).toEqual({ timeout: 3000, enabled: true });
  });

  it("uses agent-level when tool-level is undefined", () => {
    const result = resolveSandboxConfig(undefined, {
      timeout: 10000,
      maxMemoryMB: 512,
    });
    expect(result).toEqual({ timeout: 10000, maxMemoryMB: 512, enabled: true });
  });

  it("returns null when config has enabled: false", () => {
    const result = resolveSandboxConfig({ enabled: false }, undefined);
    expect(result).toBeNull();
  });

  it("merges default enabled: true into config", () => {
    const result = resolveSandboxConfig({ timeout: 5000, allowNetwork: true }, undefined);
    expect(result).toEqual({ timeout: 5000, allowNetwork: true, enabled: true });
  });
});
