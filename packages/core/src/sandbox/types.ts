/**
 * Common interface for cloud sandbox providers (E2B, Daytona, custom Docker, ...).
 *
 * Adapter implementations live alongside individual toolkits in
 * `packages/core/src/toolkits/` and are exposed to agents as a small set of
 * tools (`sandbox.run`, `sandbox.shell`, `sandbox.writeFile`, `sandbox.readFile`).
 */

export interface SandboxRunOptions {
  /**
   * Language hint for the runtime. Adapters may use this to pick a kernel,
   * file extension, or interpreter. Common values: `"python"`, `"node"`,
   * `"shell"`. Defaults to `"python"`.
   */
  language?: "python" | "node" | "shell";
  /** Maximum wall-clock seconds. Default: 30. */
  timeoutSeconds?: number;
  /** Optional environment variables. */
  env?: Record<string, string>;
}

export interface SandboxRunResult {
  /** Combined stdout + stderr. */
  output: string;
  /** Exit code reported by the runtime; 0 on success. */
  exitCode?: number;
  /** True when the run was terminated due to timeout. */
  timedOut?: boolean;
}

export interface CloudSandbox {
  /** Provider identifier for logs / events. */
  readonly providerId: string;
  /** Initialize / connect to the remote session. Idempotent. */
  start(): Promise<void>;
  /** Run code inside the sandbox and capture stdout/stderr. */
  run(code: string, options?: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Run a shell command inside the sandbox. */
  shell(command: string, options?: { timeoutSeconds?: number }): Promise<SandboxRunResult>;
  /** Write a file at `path` (UTF-8 or base64 if `encoding` set). */
  writeFile(path: string, contents: string, encoding?: "utf8" | "base64"): Promise<void>;
  /** Read a file at `path`. Returns the body or null if missing. */
  readFile(path: string, encoding?: "utf8" | "base64"): Promise<string | null>;
  /** Tear down the remote session. */
  close(): Promise<void>;
}
