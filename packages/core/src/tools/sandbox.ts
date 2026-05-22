import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunContext } from "../agent/run-context.js";
import type { SandboxConfig, ToolResult } from "./types.js";

// NOTE: This sandbox provides process isolation but is NOT a security boundary.
// The __SANDBOX_NO_NETWORK env var is a cooperative signal only; it does not enforce network restrictions.
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_MEMORY_MB = 256;

export function resolveSandboxConfig(
  toolLevel?: boolean | SandboxConfig,
  agentLevel?: boolean | SandboxConfig,
): SandboxConfig | null {
  if (toolLevel === false) return null;

  const effective = toolLevel ?? agentLevel;
  if (!effective) return null;
  if (effective === true) return { enabled: true };

  if (effective.enabled === false) return null;
  return { ...effective, enabled: true };
}

export class Sandbox {
  private config: Required<Pick<SandboxConfig, "timeout" | "maxMemoryMB">> & SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = {
      ...config,
      enabled: config.enabled !== false,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxMemoryMB: config.maxMemoryMB ?? DEFAULT_MAX_MEMORY_MB,
    };
  }

  async execute(
    toolExecuteFn: (args: Record<string, unknown>, ctx: RunContext) => Promise<string | ToolResult>,
    args: Record<string, unknown>,
    _ctx: RunContext,
  ): Promise<string | ToolResult> {
    const fnSource = toolExecuteFn.toString();

    const wrappedBody = `
      const __fn = ${fnSource};
      return await __fn(args, {});
    `;

    return new Promise<string | ToolResult>((resolve, reject) => {
      const workerPath = this.getWorkerPath();

      const execArgv: string[] = [`--max-old-space-size=${this.config.maxMemoryMB}`];

      const env: Record<string, string> = {};
      if (this.config.env) {
        for (const [key, val] of Object.entries(this.config.env)) {
          env[key] = val;
        }
      }
      if (!this.config.allowNetwork) {
        env.__SANDBOX_NO_NETWORK = "1";
      }

      const child: ChildProcess = fork(workerPath, [], {
        execArgv,
        env: { ...env, NODE_OPTIONS: execArgv.join(" ") },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        serialization: "json",
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Sandbox execution timed out after ${this.config.timeout}ms`));
      }, this.config.timeout);

      child.on("message", (msg: any) => {
        clearTimeout(timer);
        if (msg.type === "result") {
          resolve(msg.value);
        } else if (msg.type === "error") {
          reject(new Error(`Sandbox error: ${msg.message}`));
        }
        child.kill();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Sandbox process error: ${err.message}`));
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL") return;
        if (code !== 0 && code !== null) {
          reject(new Error(`Sandbox process exited with code ${code}`));
        }
      });

      child.send({
        type: "execute",
        functionBody: wrappedBody,
        args,
      });
    });
  }

  private getWorkerPath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const distDir = path.dirname(currentFile);
    return path.join(distDir, "sandbox-worker.js");
  }
}
