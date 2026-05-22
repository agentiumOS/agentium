import { describe, expect, it } from "vitest";
import { DaytonaSandboxToolkit } from "../sandbox-daytona.js";
import { E2BSandboxToolkit } from "../sandbox-e2b.js";

describe("E2BSandboxToolkit", () => {
  it("throws a friendly error when @e2b/sdk is not installed", () => {
    expect(() => new E2BSandboxToolkit()).toThrow(/@e2b\/sdk is required/);
  });
});

describe("DaytonaSandboxToolkit", () => {
  it("throws a friendly error when @daytonaio/sdk is not installed", () => {
    expect(() => new DaytonaSandboxToolkit()).toThrow(/@daytonaio\/sdk is required/);
  });
});

describe("Tool API shapes", () => {
  it("E2B toolkit exposes 4 tools with stable names (using stubbed sandbox)", async () => {
    const { E2BSandbox } = await import("../sandbox-e2b.js");
    // Bypass the constructor by mocking the SDK via the require cache trick:
    // Construct then patch private fields.
    const E2BMod = await import("../sandbox-e2b.js");
    // Build a stub Sandbox using prototype directly to avoid lazy-require.
    const stub = Object.create(E2BSandbox.prototype) as any;
    stub.providerId = "e2b";
    stub.start = async () => {};
    stub.run = async () => ({ output: "" });
    stub.shell = async () => ({ output: "" });
    stub.writeFile = async () => {};
    stub.readFile = async () => "x";
    stub.close = async () => {};

    const toolkit = Object.create(E2BMod.E2BSandboxToolkit.prototype);
    toolkit.name = "sandbox-e2b";
    toolkit.sandbox = stub;

    const tools = (toolkit as any).getTools.call(toolkit);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "sandbox_e2b_read_file",
      "sandbox_e2b_run",
      "sandbox_e2b_shell",
      "sandbox_e2b_write_file",
    ]);
  });

  it("Daytona toolkit exposes 4 tools with stable names (stub)", async () => {
    const { DaytonaSandbox } = await import("../sandbox-daytona.js");
    const DayMod = await import("../sandbox-daytona.js");
    const stub = Object.create(DaytonaSandbox.prototype) as any;
    stub.providerId = "daytona";
    stub.start = async () => {};
    stub.run = async () => ({ output: "" });
    stub.shell = async () => ({ output: "" });
    stub.writeFile = async () => {};
    stub.readFile = async () => "x";
    stub.close = async () => {};

    const toolkit = Object.create(DayMod.DaytonaSandboxToolkit.prototype);
    toolkit.name = "sandbox-daytona";
    toolkit.sandbox = stub;
    const tools = (toolkit as any).getTools.call(toolkit);
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "sandbox_daytona_read_file",
      "sandbox_daytona_run",
      "sandbox_daytona_shell",
      "sandbox_daytona_write_file",
    ]);
  });
});
