import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface CodeInterpreterConfig {
  /** Allowed languages (default: ["javascript", "python"]). */
  languages?: ("javascript" | "python" | "typescript")[];
  /** Execution timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Max output characters (default 10000). */
  maxOutput?: number;
  /** Working directory for script execution (default: os.tmpdir()). */
  cwd?: string;
}

/**
 * Code Interpreter Toolkit — execute code snippets in a subprocess.
 *
 * Runs JavaScript via `node`, Python via `python3`, and TypeScript via `npx tsx`.
 * No external dependencies required for JS; Python requires `python3` in PATH.
 *
 * @example
 * ```ts
 * const code = new CodeInterpreterToolkit({ languages: ["javascript", "python"] });
 * const agent = new Agent({ tools: [...code.getTools()] });
 * ```
 */
export class CodeInterpreterToolkit extends Toolkit {
  readonly name = "code_interpreter";
  private languages: Set<string>;
  private timeout: number;
  private maxOutput: number;
  private cwd: string;

  constructor(config: CodeInterpreterConfig = {}) {
    super();
    this.languages = new Set(config.languages ?? ["javascript", "python"]);
    this.timeout = config.timeout ?? 30000;
    this.maxOutput = config.maxOutput ?? 10000;
    this.cwd = config.cwd ?? os.tmpdir();
  }

  private static readonly LANG_CONFIG: Record<string, { ext: string; cmd: string; args: string[] }> = {
    javascript: { ext: ".js", cmd: "node", args: [] },
    python: { ext: ".py", cmd: "python3", args: [] },
    typescript: { ext: ".ts", cmd: "npx", args: ["tsx"] },
  };

  private execute(language: string, code: string): { stdout: string; stderr: string; exitCode: number } {
    const config = CodeInterpreterToolkit.LANG_CONFIG[language];
    if (!config) throw new Error(`Unsupported language: ${language}`);

    const tmpFile = path.join(this.cwd, `agentium_exec_${Date.now()}${config.ext}`);
    try {
      fs.writeFileSync(tmpFile, code, "utf-8");
      const cmdArgs = [...config.args, tmpFile];
      const output = execFileSync(config.cmd, cmdArgs, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: this.timeout,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      return { stdout: output, stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: err.status ?? 1,
      };
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
  }

  getTools(): ToolDef[] {
    const availableLangs = Array.from(this.languages);

    return [
      {
        name: "code_run",
        description: `Execute code in a subprocess and return stdout/stderr. Available languages: ${availableLangs.join(", ")}.`,
        parameters: z.object({
          language: z.enum(availableLangs as [string, ...string[]]).describe("Programming language"),
          code: z.string().describe("Code to execute"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const language = args.language as string;
          if (!this.languages.has(language)) {
            return JSON.stringify({
              error: `Language "${language}" is not enabled. Available: ${availableLangs.join(", ")}`,
            });
          }

          try {
            const result = this.execute(language, args.code as string);
            let stdout = result.stdout;
            let stderr = result.stderr;

            if (stdout.length > this.maxOutput) {
              stdout = `${stdout.slice(0, this.maxOutput)}\n...[truncated at ${this.maxOutput} chars]`;
            }
            if (stderr.length > this.maxOutput) {
              stderr = `${stderr.slice(0, this.maxOutput)}\n...[truncated at ${this.maxOutput} chars]`;
            }

            const parts: string[] = [];
            if (stdout) parts.push(`stdout:\n${stdout}`);
            if (stderr) parts.push(`stderr:\n${stderr}`);
            if (result.exitCode !== 0) parts.push(`exit code: ${result.exitCode}`);
            return parts.join("\n\n") || "(no output)";
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
