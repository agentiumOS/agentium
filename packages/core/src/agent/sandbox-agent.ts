import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CloudSandbox, SandboxRunOptions, SandboxRunResult } from "../sandbox/types.js";
import { canonicalSafeJoin } from "../utils/path-safety.js";

export interface WorkspaceFile {
  path: string;
  contents: string;
  encoding?: "utf8" | "base64";
}
export interface WorkspaceManifest {
  files?: WorkspaceFile[];
  gitClones?: Array<{ repo: string; path: string; ref?: string }>;
  env?: Record<string, string>;
}
export type SandboxBackend = "unix-local" | "remote";
export interface SandboxAgentConfig {
  /** unix-local executes trusted code on the host; it is not a security sandbox. */
  backend: SandboxBackend;
  remote?: CloudSandbox;
  workspace?: WorkspaceManifest;
  /** Explicit host environment names to forward, in addition to PATH. */
  inheritEnv?: string[];
  /** Combined captured output bound; exceeding it terminates the local process group. Default 1 MiB. */
  maxOutputBytes?: number;
}
export interface WorkspaceSnapshot {
  takenAt: number;
  files: WorkspaceFile[];
  env: Record<string, string>;
}

/** Owned workspace lifecycle. Local helpers check paths; local programs retain host privileges. */
export class SandboxAgent {
  readonly kind = "sandbox-agent" as const;
  private cfg: SandboxAgentConfig;
  private workdir: string | null = null;
  private state: "new" | "starting" | "ready" | "closing" | "closed" = "new";
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private resuming?: Promise<void>;
  private remoteAllocated = false;
  private active = new Set<Promise<unknown>>();
  private stops = new Set<() => void>();
  private env: Record<string, string>;

  constructor(config: SandboxAgentConfig) {
    this.cfg = { ...config, workspace: config.workspace ? structuredClone(config.workspace) : undefined };
    this.env = { ...(config.workspace?.env ?? {}) };
  }
  get ready(): boolean {
    return this.state === "ready";
  }

  start(): Promise<void> {
    if (this.state === "closing" || this.state === "closed")
      return Promise.reject(new Error("Sandbox is closed; use resume with a snapshot to replace it"));
    if (this.starting) return this.starting;
    if (this.ready) return Promise.resolve();
    this.state = "starting";
    this.starting = this.initialize()
      .then(() => {
        if (this.state === "starting") this.state = "ready";
      })
      .catch(async (error: unknown) => {
        try {
          await this.disposeWorkspace();
        } catch {
          /* Keep initialization failure authoritative; close can retry cleanup. */
        }
        if (this.state === "starting") this.state = "new";
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async initialize(): Promise<void> {
    if (this.cfg.backend !== "unix-local" && this.cfg.backend !== "remote")
      throw new Error(
        "Unsupported SandboxAgent backend. Docker is not implemented; choose explicit unix-local host execution or supply a remote CloudSandbox.",
      );
    const limit = this.cfg.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("maxOutputBytes must be a positive integer");
    if (this.cfg.backend === "remote") {
      if (!this.cfg.remote) throw new Error("SandboxAgent backend=remote requires `remote` CloudSandbox");
      if (this.cfg.workspace?.gitClones?.length)
        throw new Error("Remote manifest gitClones are unsupported; use the provider explicitly");
      this.remoteAllocated = true;
      await this.cfg.remote.start();
      for (const file of this.cfg.workspace?.files ?? [])
        await this.cfg.remote.writeFile(file.path, file.contents, file.encoding ?? "utf8");
      return;
    }
    if (process.platform === "win32") throw new Error("unix-local requires POSIX process-group termination");
    this.workdir = await mkdtemp(join(tmpdir(), "agentium-sbx-"));
    for (const file of this.cfg.workspace?.files ?? [])
      await this.writeLocal(file.path, file.contents, file.encoding ?? "utf8");
    for (const git of this.cfg.workspace?.gitClones ?? []) {
      const dest = await canonicalSafeJoin(this.workdir, git.path, true);
      if (git.ref?.startsWith("-")) throw new Error("Git ref must not begin with an option prefix");
      await mkdir(dirname(dest), { recursive: true });
      const cloned = await this.execute("git", ["clone", "--", git.repo, dest]);
      if (cloned.exitCode !== 0) throw new Error("Workspace git clone failed");
      if (git.ref) {
        const checked = await this.execute("git", ["-C", dest, "checkout", "--detach", git.ref]);
        if (checked.exitCode !== 0) throw new Error("Workspace git checkout failed");
      }
    }
  }
  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.starting) await this.starting;
    if (!this.ready) throw new Error("Sandbox is not ready or is closed");
    const pending = fn();
    this.active.add(pending);
    try {
      return await pending;
    } finally {
      this.active.delete(pending);
    }
  }
  private async writeLocal(path: string, contents: string, encoding: "utf8" | "base64"): Promise<void> {
    const full = await canonicalSafeJoin(this.workdir!, path, true);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(await canonicalSafeJoin(this.workdir!, path, true), Buffer.from(contents, encoding));
  }
  writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    return this.operation(() =>
      this.cfg.backend === "remote"
        ? this.cfg.remote!.writeFile(path, contents, encoding)
        : this.writeLocal(path, contents, encoding),
    );
  }
  readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    return this.operation(async () => {
      if (this.cfg.backend === "remote") return this.cfg.remote!.readFile(path, encoding);
      const full = await canonicalSafeJoin(this.workdir!, path, true);
      try {
        return (await readFile(full)).toString(encoding);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    });
  }
  shell(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    return this.operation(() =>
      this.cfg.backend === "remote"
        ? this.cfg.remote!.shell(command, { ...options, env: { ...this.env, ...options.env } })
        : this.execute("/bin/sh", ["-c", command], options),
    );
  }
  run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    return this.operation(async () => {
      if (this.cfg.backend === "remote")
        return this.cfg.remote!.run(code, { ...options, env: { ...this.env, ...options.env } });
      switch (options.language ?? "node") {
        case "node":
          return this.execute(process.execPath, ["-e", code], options);
        case "python":
          return this.execute("python3", ["-c", code], options);
        case "shell":
          return this.execute("/bin/sh", ["-c", code], options);
        default:
          throw new Error("Unsupported sandbox language");
      }
    });
  }
  private async execute(command: string, args: string[], options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const timeout = options.timeoutSeconds ?? 30;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483)
      throw new Error("timeoutSeconds must be positive and bounded");
    options.signal?.throwIfAborted();
    if (this.state === "closing" || this.state === "closed") throw new Error("Sandbox is closed");
    if (!this.workdir) throw new Error("Sandbox not started");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    for (const name of this.cfg.inheritEnv ?? []) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, this.env, options.env);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.workdir!,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      const limit = this.cfg.maxOutputBytes ?? 1_048_576;
      let size = 0;
      let timedOut = false;
      let cancelled = false;
      let outputTruncated = false;
      let failure: Error | undefined;
      let terminationRequested = false;
      const kill = () => {
        if (terminationRequested || !child.pid) return;
        // Shutdown paths can overlap before close is emitted. Signal the owned
        // process group once, then wait for its exit and output pipes to settle.
        terminationRequested = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error as Error;
        }
      };
      const stop = () => {
        cancelled = true;
        kill();
      };
      const capture = (data: Buffer) => {
        const remaining = limit - size;
        if (remaining > 0) {
          chunks.push(data.subarray(0, remaining));
          size += Math.min(data.length, remaining);
        }
        if (data.length > remaining) {
          outputTruncated = true;
          kill();
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      this.stops.add(stop);
      options.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);
      child.on("error", (error) => {
        failure = error;
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        this.stops.delete(stop);
        // close waits for process exit and its inherited output pipes to settle.
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          output: outputTruncated
            ? new StringDecoder("utf8").write(Buffer.concat(chunks))
            : Buffer.concat(chunks).toString("utf8"),
          exitCode: timedOut ? 124 : cancelled ? 130 : (code ?? (signal ? 137 : 1)),
          ...(timedOut ? { timedOut } : {}),
          ...(cancelled ? { cancelled } : {}),
          ...(outputTruncated ? { outputTruncated } : {}),
        });
      });
      if (options.signal?.aborted) stop();
    });
  }
  snapshot(): Promise<WorkspaceSnapshot> {
    return this.operation(async () => {
      if (this.cfg.backend === "remote") throw new Error("Remote snapshots require a provider-specific snapshot API");
      const files: WorkspaceFile[] = [];
      let bytes = 0;
      const walk = async (dir: string, rel: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(await canonicalSafeJoin(this.workdir!, path), path);
          else if (entry.isFile()) {
            const data = await readFile(await canonicalSafeJoin(this.workdir!, path));
            bytes += data.length;
            if (files.length >= 1000 || bytes > 16 * 1024 * 1024)
              throw new Error("Workspace snapshot exceeds 1000 files or 16 MiB");
            files.push({ path, contents: data.toString("base64"), encoding: "base64" });
          }
        }
      };
      await walk(this.workdir!, "");
      return { takenAt: Date.now(), files, env: { ...this.env } };
    });
  }
  resume(snapshot: WorkspaceSnapshot): Promise<void> {
    if (this.resuming) return Promise.reject(new Error("Sandbox resume already in progress"));
    this.resuming = (async () => {
      await this.closeWorkspace();
      this.env = { ...snapshot.env };
      this.cfg = { ...this.cfg, workspace: { files: structuredClone(snapshot.files), env: { ...snapshot.env } } };
      this.state = "new";
      this.closing = undefined;
      await this.start();
    })().finally(() => {
      this.resuming = undefined;
    });
    return this.resuming;
  }
  private async disposeWorkspace(): Promise<void> {
    if (this.remoteAllocated) {
      await this.cfg.remote!.close();
      this.remoteAllocated = false;
    }
    if (this.workdir) {
      await rm(this.workdir, { recursive: true, force: true });
      this.workdir = null;
    }
  }
  close(): Promise<void> {
    if (this.resuming)
      return this.resuming.then(
        () => this.closeWorkspace(),
        () => this.closeWorkspace(),
      );
    return this.closeWorkspace();
  }
  private closeWorkspace(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";
    for (const stop of this.stops) stop();
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      for (const stop of this.stops) stop();
      await Promise.allSettled([...this.active]);
      await this.disposeWorkspace();
      this.state = "closed";
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
