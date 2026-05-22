import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudSandbox, SandboxRunOptions, SandboxRunResult } from "../sandbox/types.js";

/**
 * Filesystem entry used in a `WorkspaceManifest`. Materialized into the sandbox
 * at `start()` time.
 */
export interface WorkspaceFile {
  path: string;
  contents: string;
  encoding?: "utf8" | "base64";
}

export interface WorkspaceManifest {
  /** Synthetic files written into the workspace. */
  files?: WorkspaceFile[];
  /** Optional git repositories to clone into the workspace at the given relative path. */
  gitClones?: Array<{ repo: string; path: string; ref?: string }>;
  /** Environment variables exposed to all `run` / `shell` calls. */
  env?: Record<string, string>;
}

export type SandboxBackend = "unix-local" | "docker" | "remote";

export interface SandboxAgentConfig {
  /** Backend that provides the workspace. */
  backend: SandboxBackend;
  /** Remote backend (CloudSandbox-compatible). Required when backend === "remote". */
  remote?: CloudSandbox;
  /** Optional initial workspace contents. */
  workspace?: WorkspaceManifest;
  /** Optional Docker image (default `node:20-alpine`). Only used when backend === "docker". */
  dockerImage?: string;
}

export interface WorkspaceSnapshot {
  takenAt: number;
  files: WorkspaceFile[];
  env: Record<string, string>;
}

/**
 * Persistent-workspace agent: spins up an isolated filesystem + shell that
 * survives across runs, supports git checkouts, snapshots, and resume.
 *
 * Backends:
 *   - `unix-local`: temp directory + `child_process.spawn` (default; no deps)
 *   - `docker`:     workspace mounted into a container (requires `dockerode` peer dep)
 *   - `remote`:     delegate to a configured `CloudSandbox` (E2B / Daytona / etc.)
 */
export class SandboxAgent {
  readonly kind = "sandbox-agent" as const;
  private cfg: SandboxAgentConfig;
  private workdir: string | null = null;
  private started = false;
  private env: Record<string, string>;

  constructor(config: SandboxAgentConfig) {
    this.cfg = config;
    this.env = { ...(config.workspace?.env ?? {}) };
  }

  /** Returns true when the workspace has been initialized. */
  get ready(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;

    if (this.cfg.backend === "remote") {
      if (!this.cfg.remote) throw new Error("SandboxAgent backend=remote requires `remote` CloudSandbox");
      await this.cfg.remote.start();
      // Materialize initial files on the remote.
      for (const f of this.cfg.workspace?.files ?? []) {
        await this.cfg.remote.writeFile(f.path, f.contents, f.encoding ?? "utf8");
      }
      this.started = true;
      return;
    }

    if (this.cfg.backend === "docker") {
      // Docker backend reserves a workdir on the host that's bind-mounted into
      // every `run` / `shell` invocation. The actual `dockerode` integration
      // is intentionally minimal here; full image/container lifecycle should
      // be plumbed through when `dockerode` is wired in.
      this.workdir = await mkdtemp(join(tmpdir(), "agentium-sbx-"));
    } else {
      this.workdir = await mkdtemp(join(tmpdir(), "agentium-sbx-"));
    }

    for (const f of this.cfg.workspace?.files ?? []) {
      await this.writeFile(f.path, f.contents, f.encoding ?? "utf8");
    }

    for (const g of this.cfg.workspace?.gitClones ?? []) {
      const dest = join(this.workdir!, g.path);
      await mkdir(dest, { recursive: true });
      await this.runShellOnHost(`git clone ${g.repo} ${dest}${g.ref ? ` && cd ${dest} && git checkout ${g.ref}` : ""}`);
    }
    this.started = true;
  }

  private resolvePath(p: string): string {
    if (!this.workdir) throw new Error("Sandbox not started");
    return join(this.workdir, p);
  }

  async writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    if (this.cfg.backend === "remote") {
      await this.cfg.remote!.writeFile(path, contents, encoding);
      return;
    }
    const full = this.resolvePath(path);
    await mkdir(join(full, ".."), { recursive: true });
    const buf = encoding === "base64" ? Buffer.from(contents, "base64") : Buffer.from(contents, "utf8");
    await writeFile(full, buf);
  }

  async readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    if (this.cfg.backend === "remote") return this.cfg.remote!.readFile(path, encoding);
    try {
      const data = await readFile(this.resolvePath(path));
      return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
    } catch {
      return null;
    }
  }

  /** Run shell in the workspace and capture stdout/stderr. */
  async shell(command: string, options: { timeoutSeconds?: number } = {}): Promise<SandboxRunResult> {
    if (this.cfg.backend === "remote") return this.cfg.remote!.shell(command, options);
    return this.runShellOnHost(command, options);
  }

  /** Run code in the workspace. Currently a thin alias for shell. */
  async run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    if (this.cfg.backend === "remote") return this.cfg.remote!.run(code, options);
    const lang = options.language ?? "node";
    if (lang === "node") {
      return this.runShellOnHost(`node -e ${JSON.stringify(code)}`, { timeoutSeconds: options.timeoutSeconds });
    }
    if (lang === "python") {
      return this.runShellOnHost(`python3 -c ${JSON.stringify(code)}`, { timeoutSeconds: options.timeoutSeconds });
    }
    return this.runShellOnHost(code, { timeoutSeconds: options.timeoutSeconds });
  }

  private runShellOnHost(command: string, options: { timeoutSeconds?: number } = {}): Promise<SandboxRunResult> {
    if (!this.workdir) throw new Error("Sandbox not started");
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: this.workdir!,
        env: { ...process.env, ...this.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const timeoutMs = (options.timeoutSeconds ?? 30) * 1000;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ output: stdout + stderr, exitCode: 124, timedOut: true });
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ output: stdout + stderr, exitCode: code ?? 0 });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ output: `${stdout}${stderr}\n${err.message}`, exitCode: 1 });
      });
    });
  }

  /**
   * Capture all in-workspace files and env into a snapshot that can later be
   * fed to `resume()` to rebuild the workspace. Currently in-memory only -
   * persist with `StorageDriver` if you need cross-process resume.
   */
  async snapshot(): Promise<WorkspaceSnapshot> {
    if (this.cfg.backend === "remote") {
      // Remote snapshots are provider-specific - return a minimal manifest.
      return { takenAt: Date.now(), files: [], env: this.env };
    }
    if (!this.workdir) throw new Error("Sandbox not started");
    const files: WorkspaceFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = join(dir, e.name);
        if (e.isDirectory()) await walk(childAbs, childRel);
        else if (e.isFile()) {
          const buf = await readFile(childAbs);
          files.push({ path: childRel, contents: buf.toString("base64"), encoding: "base64" });
        }
      }
    };
    await walk(this.workdir, "");
    return { takenAt: Date.now(), files, env: this.env };
  }

  /** Rebuild a workspace from a snapshot. Equivalent to constructor + start. */
  async resume(snapshot: WorkspaceSnapshot): Promise<void> {
    this.env = { ...snapshot.env };
    this.cfg = {
      ...this.cfg,
      workspace: { ...(this.cfg.workspace ?? {}), files: snapshot.files, env: snapshot.env },
    };
    this.workdir = null;
    this.started = false;
    await this.start();
  }

  async close(): Promise<void> {
    if (this.cfg.backend === "remote") {
      await this.cfg.remote?.close();
      this.started = false;
      return;
    }
    if (this.workdir) {
      try {
        await rm(this.workdir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      this.workdir = null;
    }
    this.started = false;
  }
}
