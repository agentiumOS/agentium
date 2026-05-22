import { createRequire } from "node:module";
import { z } from "zod";
import type { CloudSandbox, SandboxRunOptions, SandboxRunResult } from "../sandbox/types.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface E2BSandboxConfig {
  apiKey?: string;
  /** Template ID to spawn (default `"base"` per E2B). */
  template?: string;
  /** Default timeout in seconds for sandbox operations. */
  defaultTimeoutSeconds?: number;
}

/**
 * E2B sandbox adapter (https://e2b.dev). Lazy-loads the `@e2b/sdk` peer dep so
 * users who don't use E2B don't pay the install cost.
 */
export class E2BSandbox implements CloudSandbox {
  readonly providerId = "e2b";
  private sdk: any;
  private session: any = null;
  private apiKey: string | undefined;
  private template: string;
  private defaultTimeout: number;

  constructor(config: E2BSandboxConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.E2B_API_KEY;
    this.template = config.template ?? "base";
    this.defaultTimeout = config.defaultTimeoutSeconds ?? 30;
    try {
      this.sdk = _require("@e2b/sdk");
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("@e2b/sdk is required for E2BSandbox. Install it: npm install @e2b/sdk");
      }
      throw e;
    }
  }

  async start(): Promise<void> {
    if (this.session) return;
    const Sandbox = this.sdk.Sandbox ?? this.sdk.default?.Sandbox;
    if (!Sandbox) throw new Error("E2B SDK does not expose a `Sandbox` class");
    this.session = await Sandbox.create({ template: this.template, apiKey: this.apiKey });
  }

  private async ensure(): Promise<any> {
    if (!this.session) await this.start();
    return this.session;
  }

  async run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const s = await this.ensure();
    const lang = options.language ?? "python";
    const timeoutMs = (options.timeoutSeconds ?? this.defaultTimeout) * 1000;
    const handle = await s.runCode(code, { language: lang, env: options.env, timeoutMs });
    return {
      output: (handle.logs?.stdout?.join("") ?? "") + (handle.logs?.stderr?.join("") ?? ""),
      exitCode: (handle.exitCode ?? handle.error) ? 1 : 0,
    };
  }

  async shell(command: string, options: { timeoutSeconds?: number } = {}): Promise<SandboxRunResult> {
    const s = await this.ensure();
    const timeoutMs = (options.timeoutSeconds ?? this.defaultTimeout) * 1000;
    const handle = await s.commands?.run?.(command, { timeoutMs });
    if (handle) {
      return {
        output: (handle.stdout ?? "") + (handle.stderr ?? ""),
        exitCode: handle.exitCode ?? 0,
      };
    }
    // Older SDK: fall back to running as shell code.
    return this.run(command, { language: "shell", timeoutSeconds: options.timeoutSeconds });
  }

  async writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    const s = await this.ensure();
    if (s.files?.write) {
      await s.files.write(path, encoding === "base64" ? Buffer.from(contents, "base64") : contents);
    } else {
      await s.filesystem.write(path, contents);
    }
  }

  async readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    const s = await this.ensure();
    try {
      const data = s.files?.read ? await s.files.read(path) : await s.filesystem.read(path);
      if (data == null) return null;
      if (Buffer.isBuffer(data)) return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
      return data as string;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.kill?.();
      this.session = null;
    }
  }
}

/**
 * Toolkit exposing the E2B sandbox to an agent as a small set of tools.
 *
 * @example
 * ```ts
 * const sandbox = new E2BSandboxToolkit({ apiKey: process.env.E2B_API_KEY });
 * const agent = new Agent({ tools: sandbox.getTools() });
 * ```
 */
export class E2BSandboxToolkit extends Toolkit {
  readonly name = "sandbox-e2b";
  private sandbox: E2BSandbox;

  constructor(config: E2BSandboxConfig = {}) {
    super();
    this.sandbox = new E2BSandbox(config);
  }

  getTools(): ToolDef[] {
    const sandbox = this.sandbox;
    return [
      {
        name: "sandbox_e2b_run",
        description: "Run code in an isolated E2B cloud sandbox (Python by default). Returns stdout+stderr.",
        parameters: z.object({
          code: z.string(),
          language: z.enum(["python", "node", "shell"]).optional(),
          timeoutSeconds: z.number().optional(),
        }),
        execute: async (args: any) => {
          const r = await sandbox.run(args.code, { language: args.language, timeoutSeconds: args.timeoutSeconds });
          return JSON.stringify(r);
        },
      },
      {
        name: "sandbox_e2b_shell",
        description: "Run a shell command in the E2B sandbox.",
        parameters: z.object({ command: z.string(), timeoutSeconds: z.number().optional() }),
        execute: async (args: any) => {
          const r = await sandbox.shell(args.command, { timeoutSeconds: args.timeoutSeconds });
          return JSON.stringify(r);
        },
      },
      {
        name: "sandbox_e2b_write_file",
        description: "Write a file inside the E2B sandbox at the given path.",
        parameters: z.object({
          path: z.string(),
          contents: z.string(),
          encoding: z.enum(["utf8", "base64"]).optional(),
        }),
        execute: async (args: any) => {
          await sandbox.writeFile(args.path, args.contents, args.encoding);
          return "ok";
        },
      },
      {
        name: "sandbox_e2b_read_file",
        description: "Read a file from the E2B sandbox.",
        parameters: z.object({ path: z.string(), encoding: z.enum(["utf8", "base64"]).optional() }),
        execute: async (args: any) => {
          const out = await sandbox.readFile(args.path, args.encoding);
          return out ?? "[file not found]";
        },
      },
    ];
  }

  /** Returns the underlying `E2BSandbox` for advanced direct use. */
  getSandbox(): E2BSandbox {
    return this.sandbox;
  }

  async close(): Promise<void> {
    await this.sandbox.close();
  }
}
