import { describe, expect, it } from "vitest";
import { SandboxAgent } from "../sandbox-agent.js";

describe("SandboxAgent (unix-local)", () => {
  it("starts and materializes initial files", async () => {
    const agent = new SandboxAgent({
      backend: "unix-local",
      workspace: { files: [{ path: "hello.txt", contents: "world" }] },
    });
    await agent.start();
    const out = await agent.readFile("hello.txt");
    expect(out).toBe("world");
    await agent.close();
  });

  it("writeFile + readFile round-trip", async () => {
    const agent = new SandboxAgent({ backend: "unix-local" });
    await agent.start();
    await agent.writeFile("a/b/c.txt", "nested");
    expect(await agent.readFile("a/b/c.txt")).toBe("nested");
    await agent.close();
  });

  it("readFile returns null for missing path", async () => {
    const agent = new SandboxAgent({ backend: "unix-local" });
    await agent.start();
    expect(await agent.readFile("nope.txt")).toBeNull();
    await agent.close();
  });

  it("shell captures stdout and exit code", async () => {
    const agent = new SandboxAgent({ backend: "unix-local" });
    await agent.start();
    const r = await agent.shell("echo hi && exit 0");
    expect(r.output).toContain("hi");
    expect(r.exitCode).toBe(0);
    await agent.close();
  });

  it("shell respects timeout", async () => {
    const agent = new SandboxAgent({ backend: "unix-local" });
    await agent.start();
    const r = await agent.shell("sleep 5", { timeoutSeconds: 1 });
    expect(r.timedOut).toBe(true);
    await agent.close();
  });

  it("run('node') executes JS code", async () => {
    const agent = new SandboxAgent({ backend: "unix-local" });
    await agent.start();
    const r = await agent.run("console.log(40+2)", { language: "node" });
    expect(r.output).toContain("42");
    await agent.close();
  });

  it("snapshot + resume restores files", async () => {
    const a = new SandboxAgent({ backend: "unix-local" });
    await a.start();
    await a.writeFile("state.txt", "carry-over");
    const snap = await a.snapshot();
    await a.close();

    const b = new SandboxAgent({ backend: "unix-local" });
    await b.resume(snap);
    expect(await b.readFile("state.txt")).toBe("carry-over");
    await b.close();
  });

  it("remote backend without remote throws", async () => {
    const agent = new SandboxAgent({ backend: "remote" });
    await expect(agent.start()).rejects.toThrow(/requires `remote`/);
  });

  it("remote backend delegates to the CloudSandbox", async () => {
    const writeFile = (await import("vitest")).vi.fn(async () => {});
    const readFile = (await import("vitest")).vi.fn(async () => "v");
    const shell = (await import("vitest")).vi.fn(async () => ({ output: "ok", exitCode: 0 }));
    const start = (await import("vitest")).vi.fn(async () => {});
    const close = (await import("vitest")).vi.fn(async () => {});
    const remote: any = {
      providerId: "stub",
      start,
      run: async () => ({ output: "" }),
      shell,
      writeFile,
      readFile,
      close,
    };

    const agent = new SandboxAgent({ backend: "remote", remote, workspace: { files: [{ path: "x", contents: "y" }] } });
    await agent.start();
    expect(start).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith("x", "y", "utf8");
    expect(await agent.readFile("x")).toBe("v");
    await agent.shell("echo");
    expect(shell).toHaveBeenCalled();
    await agent.close();
    expect(close).toHaveBeenCalled();
  });
});
