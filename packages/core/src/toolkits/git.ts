import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface GitConfig {
  /** Working directory for git commands (default: process.cwd()). */
  cwd?: string;
  /** Max output characters (default 10000). */
  maxOutput?: number;
}

/**
 * Git Toolkit — local git operations: status, diff, log, commit, branch.
 *
 * No external dependencies — uses the system `git` binary via `execFileSync`.
 *
 * @example
 * ```ts
 * const git = new GitToolkit({ cwd: "/path/to/repo" });
 * const agent = new Agent({ tools: [...git.getTools()] });
 * ```
 */
export class GitToolkit extends Toolkit {
  readonly name = "git";
  private cwd: string;
  private maxOutput: number;

  constructor(config: GitConfig = {}) {
    super();
    this.cwd = config.cwd ?? process.cwd();
    this.maxOutput = config.maxOutput ?? 10000;
  }

  private run(args: string[]): string {
    try {
      const output = execFileSync("git", args, {
        cwd: this.cwd,
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (output.length > this.maxOutput) {
        return `${output.slice(0, this.maxOutput)}\n...[truncated at ${this.maxOutput} chars]`;
      }
      return output || "(no output)";
    } catch (err: any) {
      return `Error: ${err.stderr || err.message}`;
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "git_status",
        description: "Show the working tree status (modified, staged, untracked files).",
        parameters: z.object({}),
        execute: async (_args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          return this.run(["status", "--porcelain=v2", "--branch"]);
        },
      },
      {
        name: "git_diff",
        description: "Show changes between commits, working tree, etc.",
        parameters: z.object({
          staged: z.boolean().optional().describe("Show staged changes only (default: unstaged)"),
          file: z.string().optional().describe("Limit diff to a specific file path"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const cmdArgs = ["diff"];
          if (args.staged) cmdArgs.push("--staged");
          if (args.file) cmdArgs.push("--", args.file as string);
          return this.run(cmdArgs);
        },
      },
      {
        name: "git_log",
        description: "Show commit log history.",
        parameters: z.object({
          count: z.number().optional().describe("Number of commits to show (default 10)"),
          oneline: z.boolean().optional().describe("One-line format (default true)"),
          file: z.string().optional().describe("Show commits for a specific file"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const count = (args.count as number) ?? 10;
          const oneline = (args.oneline as boolean) ?? true;
          const cmdArgs = ["log", `-${count}`];
          if (oneline) cmdArgs.push("--oneline");
          if (args.file) cmdArgs.push("--", args.file as string);
          return this.run(cmdArgs);
        },
      },
      {
        name: "git_commit",
        description: "Stage files and create a commit.",
        parameters: z.object({
          message: z.string().describe("Commit message"),
          files: z.array(z.string()).optional().describe("Files to stage (default: all modified)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const files = args.files as string[] | undefined;
          if (files && files.length > 0) {
            this.run(["add", ...files]);
          } else {
            this.run(["add", "-A"]);
          }
          return this.run(["commit", "-m", args.message as string]);
        },
      },
      {
        name: "git_branch",
        description: "List, create, or switch branches.",
        parameters: z.object({
          action: z.enum(["list", "create", "switch"]).describe("Branch action"),
          name: z.string().optional().describe("Branch name (required for create/switch)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const action = args.action as string;
          const name = args.name as string | undefined;
          switch (action) {
            case "list":
              return this.run(["branch", "-a", "--no-color"]);
            case "create":
              if (!name) return "Error: branch name required";
              return this.run(["checkout", "-b", name]);
            case "switch":
              if (!name) return "Error: branch name required";
              return this.run(["checkout", name]);
            default:
              return `Unknown action: ${action}`;
          }
        },
      },
    ];
  }
}
