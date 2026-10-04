import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSandbox } from "../../sandbox/types.js";
import { SandboxAgent } from "../sandbox-agent.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp) };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  return { ...child, spawn: vi.fn(child.spawn) };
});

const owned: SandboxAgent[] = [];
const sandbox = (config: ConstructorParameters<typeof SandboxAgent>[0] = { backend: "unix-local" }) => {
  const agent = new SandboxAgent(config);
  owned.push(agent);
  return agent;
};
afterEach(async () => {
  await Promise.all(owned.splice(0).map((agent) => agent.close()));
});

describe("SandboxAgent execution boundary", () => {
  it("rejects stale Docker/unknown selectors without allocating or dispatching", async () => {
    const fs = await import("node:fs/promises");
    const child = await import("node:child_process");
    const allocate = vi.spyOn(fs, "mkdtemp");
    const spawn = vi.spyOn(child, "spawn");
    try {
      for (const backend of ["docker", "typo"])
        await expect(sandbox({ backend } as never).start()).rejects.toThrow("Unsupported");
      expect(allocate).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
      spawn.mockRestore();
    }
  });
  it("passes source literally and forwards only explicit environment", async () => {
    const agent = sandbox({ backend: "unix-local", workspace: { env: { FIXTURE: "from workspace" } } });
    await agent.start();
    const value = "$HOME `literal` $(literal) \\";
    const result = await agent.run(
      `console.log(JSON.stringify([${JSON.stringify(value)},process.env.FIXTURE,process.env.HOME]))`,
      { env: { FIXTURE: "from run" } },
    );
    expect(JSON.parse(result.output)).toEqual([value, "from run", null]);
  });
  it("rejects traversals and external symlinks while preserving missing/error distinctions", async () => {
    const agent = sandbox();
    await agent.start();
    const outside = await mkdtemp(join(tmpdir(), "agentium-outside-"));
    try {
      const cwd = (await agent.run("console.log(process.cwd())")).output.trim();
      await symlink(outside, join(cwd, "escape"));
      await symlink(join(outside, "missing"), join(cwd, "dangling"));
      for (const path of ["../outside", `${outside}/file`, "escape/file"]) {
        await expect(agent.writeFile(path, "no")).rejects.toThrow();
        await expect(agent.readFile(path)).rejects.toThrow();
      }
      await expect(agent.readFile("dangling")).rejects.toThrow();
      await agent.writeFile("dir/file", "ok");
      expect(await agent.readFile("missing")).toBeNull();
      await expect(agent.readFile("dir")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("serializes starts, deletes previous workspace on resume, and rejects use after close", async () => {
    const agent = sandbox();
    await Promise.all([agent.start(), agent.start(), agent.start()]);
    const before = (await agent.run("console.log(process.cwd())")).output.trim();
    await agent.writeFile("keep", "yes");
    const snapshot = await agent.snapshot();
    await agent.resume(snapshot);
    await expect(access(before)).rejects.toThrow();
    expect(await agent.readFile("keep")).toBe("yes");
    const after = (await agent.run("console.log(process.cwd())")).output.trim();
    await Promise.all([agent.close(), agent.close()]);
    await expect(access(after)).rejects.toThrow();
    await expect(agent.run("0")).rejects.toThrow("closed");
    await expect(agent.start()).rejects.toThrow("closed");
  });
  it("cleans a partially materialized manifest after initialization failure", async () => {
    const fs = await import("node:fs/promises");
    const allocate = vi.spyOn(fs, "mkdtemp");
    try {
      const agent = sandbox({
        backend: "unix-local",
        workspace: {
          files: [
            { path: "ok", contents: "ok" },
            { path: "../bad", contents: "bad" },
          ],
        },
      });
      await expect(agent.start()).rejects.toThrow("traversal");
      const allocated = await allocate.mock.results[0].value;
      await expect(access(allocated)).rejects.toThrow();
      expect(agent.ready).toBe(false);
    } finally {
      allocate.mockRestore();
    }
  });
  it("settles concurrent resume and close with no replacement workspace left open", async () => {
    const agent = sandbox();
    await agent.start();
    const snapshot = await agent.snapshot();
    await Promise.all([agent.resume(snapshot), agent.close()]);
    expect(agent.ready).toBe(false);
    await expect(agent.readFile("anything")).rejects.toThrow("closed");
  });
  it("bounds output and waits for process-group timeout and cancellation to settle", async () => {
    const agent = sandbox({ backend: "unix-local", maxOutputBytes: 64 });
    await agent.start();
    const flood = await agent.run("process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)");
    expect(Buffer.byteLength(flood.output)).toBe(64);
    expect(flood.outputTruncated).toBe(true);
    const timed = await agent.shell("sleep 5 & wait", { timeoutSeconds: 0.03 });
    expect(timed).toMatchObject({ timedOut: true, exitCode: 124 });
    const controller = new AbortController();
    const pending = agent.shell("sleep 5 & wait", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(await pending).toMatchObject({ cancelled: true, exitCode: 130 });
    const running = agent.shell("sleep 5 & wait");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agent.close();
    expect(await running).toMatchObject({ cancelled: true });
  });
  it("cleans remote initialization failure and does not invent a remote snapshot", async () => {
    const remote: CloudSandbox = {
      providerId: "fixture",
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      run: vi.fn(async () => ({ output: "" })),
      shell: vi.fn(async () => ({ output: "" })),
      writeFile: vi.fn(async () => {
        throw new Error("denied");
      }),
      readFile: vi.fn(async () => null),
    };
    const failed = sandbox({ backend: "remote", remote, workspace: { files: [{ path: "x", contents: "x" }] } });
    await expect(failed.start()).rejects.toThrow("denied");
    expect(remote.close).toHaveBeenCalledTimes(1);
    const agent = sandbox({ backend: "remote", remote });
    await agent.start();
    await expect(agent.snapshot()).rejects.toThrow("provider-specific");
  });
});
