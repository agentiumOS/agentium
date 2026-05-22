import { createRequire } from "node:module";
import { z } from "zod";
import type { CloudSandbox, SandboxRunOptions, SandboxRunResult } from "../sandbox/types.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface DaytonaSandboxConfig {
  apiKey?: string;
  /** Optional override for the Daytona API host. */
  baseURL?: string;
  /** Workspace / project name. */
  workspace?: string;
  /** Default timeout in seconds. */
  defaultTimeoutSeconds?: number;
}

/**
 * Daytona sandbox adapter (https://daytona.io). Lazy-loads the `@daytonaio/sdk`
 * peer dep so users who don't use Daytona don't pay the install cost.
 */
export class DaytonaSandbox implements CloudSandbox {
  readonly providerId = "daytona";
  private sdk: any;
  private session: any = null;
  private apiKey: string | undefined;
  private baseURL?: string;
  private workspace: string;
  private defaultTimeout: number;

  constructor(config: DaytonaSandboxConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.DAYTONA_API_KEY;
    this.baseURL = config.baseURL;
    this.workspace = config.workspace ?? "default";
    this.defaultTimeout = config.defaultTimeoutSeconds ?? 30;
    try {
      this.sdk = _require("@daytonaio/sdk");
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error("@daytonaio/sdk is required for DaytonaSandbox. Install it: npm install @daytonaio/sdk");
      }
      throw e;
    }
  }

  async start(): Promise<void> {
    if (this.session) return;
    const Daytona = this.sdk.Daytona ?? this.sdk.default?.Daytona;
    if (!Daytona) throw new Error("Daytona SDK does not expose a `Daytona` client");
    const client = new Daytona({ apiKey: this.apiKey, baseURL: this.baseURL });
    this.session = await client.create({ workspaceName: this.workspace });
  }

  private async ensure(): Promise<any> {
    if (!this.session) await this.start();
    return this.session;
  }

  async run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const s = await this.ensure();
    const lang = options.language ?? "python";
    const timeoutMs = (options.timeoutSeconds ?? this.defaultTimeout) * 1000;
    const res = await s.runCode(code, { language: lang, env: options.env, timeoutMs });
    return {
      output: (res.stdout ?? "") + (res.stderr ?? ""),
      exitCode: res.exitCode ?? 0,
    };
  }

  async shell(command: string, options: { timeoutSeconds?: number } = {}): Promise<SandboxRunResult> {
    const s = await this.ensure();
    const timeoutMs = (options.timeoutSeconds ?? this.defaultTimeout) * 1000;
    const res = await s.exec(command, { timeoutMs });
    return {
      output: (res.stdout ?? "") + (res.stderr ?? ""),
      exitCode: res.exitCode ?? 0,
    };
  }

  async writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    const s = await this.ensure();
    const body = encoding === "base64" ? Buffer.from(contents, "base64") : contents;
    if (s.fs?.write) await s.fs.write(path, body);
    else await s.writeFile?.(path, body);
  }

  async readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    const s = await this.ensure();
    try {
      const data = s.fs?.read ? await s.fs.read(path) : await s.readFile?.(path);
      if (data == null) return null;
      if (Buffer.isBuffer(data)) return encoding === "base64" ? data.toString("base64") : data.toString("utf8");
      return data as string;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.delete?.();
      this.session = null;
    }
  }
}

export class DaytonaSandboxToolkit extends Toolkit {
  readonly name = "sandbox-daytona";
  private sandbox: DaytonaSandbox;

  constructor(config: DaytonaSandboxConfig = {}) {
    super();
    this.sandbox = new DaytonaSandbox(config);
  }

  getTools(): ToolDef[] {
    const sandbox = this.sandbox;
    return [
      {
        name: "sandbox_daytona_run",
        description: "Run code in a Daytona cloud sandbox.",
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
        name: "sandbox_daytona_shell",
        description: "Run a shell command in the Daytona sandbox.",
        parameters: z.object({ command: z.string(), timeoutSeconds: z.number().optional() }),
        execute: async (args: any) => {
          const r = await sandbox.shell(args.command, { timeoutSeconds: args.timeoutSeconds });
          return JSON.stringify(r);
        },
      },
      {
        name: "sandbox_daytona_write_file",
        description: "Write a file inside the Daytona sandbox.",
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
        name: "sandbox_daytona_read_file",
        description: "Read a file from the Daytona sandbox.",
        parameters: z.object({ path: z.string(), encoding: z.enum(["utf8", "base64"]).optional() }),
        execute: async (args: any) => {
          const out = await sandbox.readFile(args.path, args.encoding);
          return out ?? "[file not found]";
        },
      },
    ];
  }

  getSandbox(): DaytonaSandbox {
    return this.sandbox;
  }

  async close(): Promise<void> {
    await this.sandbox.close();
  }
}
