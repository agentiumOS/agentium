import { exec as execCb } from "node:child_process";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface ShellConfig {
  /** Shell to use (default: platform default). */
  shell?: string;
  /** Command timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Max output characters to return (default 10000). Truncates from the end. */
  maxOutput?: number;
  /** Working directory for commands. */
  cwd?: string;
  /** Allowlist of command prefixes. If set, only commands starting with one of these are permitted. */
  allowedCommands?: string[];
}

/**
 * Shell Toolkit — execute shell commands from your agent.
 *
 * Supports timeouts, output truncation, and an optional command allowlist for safety.
 *
 * @example
 * ```ts
 * const shell = new ShellToolkit({ timeout: 10000, allowedCommands: ["ls", "cat", "grep"] });
 * const agent = new Agent({ tools: [...shell.getTools()] });
 * ```
 */
export class ShellToolkit extends Toolkit {
  readonly name = "shell";
  private config: Required<Pick<ShellConfig, "timeout" | "maxOutput">> & ShellConfig;

  constructor(config: ShellConfig = {}) {
    super();
    this.config = {
      ...config,
      timeout: config.timeout ?? 30_000,
      maxOutput: config.maxOutput ?? 10_000,
    };
  }

  private static readonly SHELL_METACHAR = /[;|&`$(){}\\<>\n\r]/;

  private validateCommand(command: string): void {
    if (!this.config.allowedCommands?.length) return;

    const trimmed = command.trimStart();
    const baseCmd = trimmed.split(/\s/)[0];

    if (ShellToolkit.SHELL_METACHAR.test(baseCmd)) {
      throw new Error("Command contains disallowed shell metacharacters");
    }

    const allowed = this.config.allowedCommands.some(
      (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
    );

    if (!allowed) {
      throw new Error(`Command not allowed. Permitted prefixes: ${this.config.allowedCommands.join(", ")}`);
    }

    if (ShellToolkit.SHELL_METACHAR.test(trimmed)) {
      throw new Error(
        "Command contains disallowed shell metacharacters (;|&`$(){}\\<>). Use separate commands instead.",
      );
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "shell_exec",
        description:
          "Execute a shell command and return stdout and stderr. Use for running scripts, CLI tools, or system commands.",
        parameters: z.object({
          command: z.string().describe("The shell command to execute"),
          cwd: z.string().optional().describe("Working directory (overrides default)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const command = args.command as string;
          this.validateCommand(command);

          const cwd = (args.cwd as string) ?? this.config.cwd;

          return new Promise<string>((resolve) => {
            execCb(
              command,
              {
                timeout: this.config.timeout,
                maxBuffer: 1024 * 1024 * 10,
                cwd,
                shell: this.config.shell,
              },
              (error, stdout, stderr) => {
                const parts: string[] = [];

                if (stdout) {
                  let out = stdout.toString();
                  if (out.length > this.config.maxOutput) {
                    out = `...(truncated)\n${out.slice(-this.config.maxOutput)}`;
                  }
                  parts.push(`STDOUT:\n${out}`);
                }

                if (stderr) {
                  let err = stderr.toString();
                  if (err.length > this.config.maxOutput) {
                    err = `...(truncated)\n${err.slice(-this.config.maxOutput)}`;
                  }
                  parts.push(`STDERR:\n${err}`);
                }

                if (error) {
                  parts.push(`EXIT CODE: ${error.code ?? 1}`);
                  if (!stdout && !stderr) {
                    parts.push(`ERROR: ${error.message}`);
                  }
                } else {
                  parts.push("EXIT CODE: 0");
                }

                resolve(parts.join("\n\n"));
              },
            );
          });
        },
      },
    ];
  }
}
