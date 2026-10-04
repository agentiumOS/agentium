import { describe, expect, it, vi } from "vitest";
import { DaytonaSandbox, type DaytonaSandboxSession } from "../sandbox-daytona.js";
import { E2BSandbox, type E2BSandboxSession } from "../sandbox-e2b.js";

function e2b() {
  const files = new Map<string, Uint8Array>();
  const session: E2BSandboxSession = {
    runCode: vi.fn(async () => ({ logs: { stdout: ["ok"], stderr: ["err"] } })),
    commands: { run: vi.fn(async () => ({ stdout: "out", stderr: "err", exitCode: 7 })) },
    files: {
      write: vi.fn(async (path, bytes) => {
        files.set(path, Buffer.from(bytes));
      }),
      read: vi.fn(async (path) => files.get(path)!),
    },
    kill: vi.fn(async () => true),
  };
  const create = vi.fn(async () => session);
  return { session, create, adapter: new E2BSandbox({ sdk: { Sandbox: { create } }, maxOutputBytes: 10 }) };
}
function daytona() {
  const files = new Map<string, Buffer>();
  const session: DaytonaSandboxSession = {
    process: {
      codeRun: vi.fn(async () => ({ result: "ok", exitCode: 3 })),
      executeCommand: vi.fn(async () => ({ result: "out", exitCode: 7 })),
    },
    fs: {
      uploadFile: vi.fn(async (bytes, path) => {
        files.set(path, bytes);
      }),
      downloadFile: vi.fn(async (path) => files.get(path)!),
    },
    delete: vi.fn(async () => {}),
  };
  const create = vi.fn(async () => session);
  return { session, create, adapter: new DaytonaSandbox({ client: { create }, language: "node", maxOutputBytes: 10 }) };
}
describe("E2B 2.8 SDK adapter contract", () => {
  it("creates once with interpreter template default and maps languages/env/milliseconds/exit codes", async () => {
    const f = e2b();
    await Promise.all([f.adapter.start(), f.adapter.start()]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith({ apiKey: undefined, timeoutMs: 300000, requestTimeoutMs: 30000 });
    await f.adapter.run("literal", { language: "node", timeoutSeconds: 2, env: { X: "1" } });
    expect(f.session.runCode).toHaveBeenCalledWith("literal", {
      language: "javascript",
      timeoutMs: 2000,
      requestTimeoutMs: 2000,
      envs: { X: "1" },
    });
    expect(await f.adapter.shell("exit 7")).toMatchObject({ exitCode: 7, output: "outerr" });
    vi.mocked(f.session.commands.run).mockRejectedValueOnce(
      Object.assign(new Error("exit"), { name: "CommandExitError", stdout: "a", stderr: "b", exitCode: 5 }),
    );
    expect(await f.adapter.shell("exit 5")).toMatchObject({ exitCode: 5, output: "ab" });
    await Promise.all([f.adapter.close(), f.adapter.close()]);
    expect(f.session.kill).toHaveBeenCalledTimes(1);
    await expect(f.adapter.run("0")).rejects.toThrow("closed");
  });
  it("preserves binary, distinguishes file absence, rejects transport failures and truncates result output", async () => {
    const f = e2b();
    const binary = Buffer.from([0, 255, 128]).toString("base64");
    await f.adapter.writeFile("blob", binary, "base64");
    expect(await f.adapter.readFile("blob", "base64")).toBe(binary);
    vi.mocked(f.session.files.read).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { name: "FileNotFoundError" }),
    );
    expect(await f.adapter.readFile("none")).toBeNull();
    vi.mocked(f.session.files.read).mockRejectedValueOnce(
      Object.assign(new Error("missing sandbox"), { name: "SandboxNotFoundError" }),
    );
    await expect(f.adapter.readFile("none")).rejects.toThrow("missing sandbox");
    vi.mocked(f.session.runCode).mockResolvedValueOnce({
      logs: { stdout: ["x".repeat(20)], stderr: [] },
      error: { name: "Error", value: "failure", traceback: "" },
    });
    expect(await f.adapter.run("0")).toMatchObject({ output: "x".repeat(10), outputTruncated: true, exitCode: 1 });
    await f.adapter.close();
  });
  it("rejects a missing capability and cleans the created resource before any tool dispatch", async () => {
    const f = e2b();
    (f.session.files as unknown as Record<string, unknown>).write = undefined;
    await expect(f.adapter.writeFile("x", "x")).rejects.toThrow("files.write");
    expect(f.session.kill).toHaveBeenCalledTimes(1);
    expect(f.session.runCode).not.toHaveBeenCalled();
    await f.adapter.close();
  });
  it("retains failed cleanup for an explicit retry and closes during pending creation", async () => {
    const f = e2b();
    (f.session.files as unknown as Record<string, unknown>).write = undefined;
    vi.mocked(f.session.kill).mockRejectedValueOnce(new Error("cleanup unavailable"));
    await expect(f.adapter.start()).rejects.toThrow("cleanup failed");
    await f.adapter.close();
    expect(f.session.kill).toHaveBeenCalledTimes(2);
    const next = e2b();
    let created!: (session: E2BSandboxSession) => void;
    next.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = resolve;
        }),
    );
    const starting = next.adapter.start();
    const closing = next.adapter.close();
    created(next.session);
    await starting;
    await closing;
    expect(next.session.kill).toHaveBeenCalledTimes(1);
    await expect(next.adapter.run("0")).rejects.toThrow("closed");
  });
});
describe("Daytona 0.220 SDK adapter contract", () => {
  it("maps create language, seconds, env, result and nonzero exits without a guessed fallback", async () => {
    const f = daytona();
    await Promise.all([f.adapter.start(), f.adapter.start()]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith(
      { language: "javascript", autoStopInterval: 5, autoDeleteInterval: 0 },
      { timeout: 30 },
    );
    expect(await f.adapter.run("literal", { language: "node", env: { X: "1" }, timeoutSeconds: 2 })).toEqual({
      output: "ok",
      exitCode: 3,
    });
    expect(f.session.process.codeRun).toHaveBeenCalledWith("literal", { env: { X: "1" } }, 2);
    await expect(f.adapter.run("0", { language: "python" })).rejects.toThrow("fixed at creation");
    expect(await f.adapter.shell("exit 7", { timeoutSeconds: 4 })).toEqual({ output: "out", exitCode: 7 });
    expect(f.session.process.executeCommand).toHaveBeenCalledWith("exit 7", undefined, undefined, 4);
    await Promise.all([f.adapter.close(), f.adapter.close()]);
    expect(f.session.delete).toHaveBeenCalledTimes(1);
  });
  it("uses binary upload/download, preserves missing-file vs missing-sandbox errors", async () => {
    const f = daytona();
    const binary = Buffer.from([0, 255]).toString("base64");
    await f.adapter.writeFile("blob", binary, "base64");
    expect(await f.adapter.readFile("blob", "base64")).toBe(binary);
    expect(f.session.fs.uploadFile).toHaveBeenCalledWith(Buffer.from([0, 255]), "blob", 30);
    vi.mocked(f.session.fs.downloadFile).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "FILE_NOT_FOUND" }),
    );
    expect(await f.adapter.readFile("none")).toBeNull();
    vi.mocked(f.session.fs.downloadFile).mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { statusCode: 403 }),
    );
    await expect(f.adapter.readFile("none")).rejects.toThrow("forbidden");
    await f.adapter.close();
  });
  it("waits for an in-flight SDK operation before closing; cancellation never claims remote termination", async () => {
    const f = daytona();
    const controller = new AbortController();
    let finish!: (value: { result: string; exitCode: number }) => void;
    vi.mocked(f.session.process.codeRun).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = f.adapter.run("0", { signal: controller.signal });
    const result = expect(run).rejects.toThrow("cancel");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort(new Error("cancel"));
    const close = f.adapter.close();
    expect(f.session.delete).not.toHaveBeenCalled();
    finish({ result: "completed remotely", exitCode: 0 });
    await result;
    await close;
    expect(f.session.delete).toHaveBeenCalledTimes(1);
  });
  it("rejects pre-aborted operations before creating any resource", async () => {
    const f = daytona();
    const controller = new AbortController();
    controller.abort(new Error("cancel"));
    await expect(f.adapter.run("0", { signal: controller.signal })).rejects.toThrow("cancel");
    expect(f.create).not.toHaveBeenCalled();
    await f.adapter.close();
  });
  it("disposes an owned SDK client after failed creation without closing borrowed clients", async () => {
    const dispose = vi.fn(async () => {});
    class Client {
      create = vi.fn(async (): Promise<DaytonaSandboxSession> => {
        throw new Error("create unavailable");
      });
      [Symbol.asyncDispose] = dispose;
    }
    const adapter = new DaytonaSandbox({ sdk: { Daytona: Client } });
    await expect(adapter.start()).rejects.toThrow("create unavailable");
    expect(dispose).toHaveBeenCalledTimes(1);
    await Promise.all([adapter.close(), adapter.close()]);
    expect(dispose).toHaveBeenCalledTimes(1);
    const f = daytona();
    const borrowed = new Client();
    borrowed.create = f.create;
    const other = new DaytonaSandbox({ client: borrowed });
    await other.start();
    await other.close();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.session.delete).toHaveBeenCalledWith(30, true);
  });
});
