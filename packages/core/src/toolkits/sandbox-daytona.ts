import { createRequire } from "node:module";
import { z } from "zod/v3";
import {
  requireSandboxMethods,
  SandboxSessionOwner,
  sandboxOutputLimit,
  sandboxResult,
  sandboxTimeout,
} from "../sandbox/lifecycle.js";
import type { CloudSandbox, SandboxRunOptions, SandboxRunResult } from "../sandbox/types.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const requireSDK = createRequire(import.meta.url);
export interface DaytonaSandboxSession {
  process: {
    codeRun(
      code: string,
      params: { env?: Record<string, string> },
      timeout: number,
    ): Promise<{ result: string; exitCode: number }>;
    executeCommand(
      command: string,
      cwd: undefined,
      env: Record<string, string> | undefined,
      timeout: number,
    ): Promise<{ result: string; exitCode: number }>;
  };
  fs: {
    uploadFile(data: Buffer, path: string, timeout: number): Promise<void>;
    downloadFile(path: string, timeout: number): Promise<Buffer>;
  };
  delete(timeout: number, wait: boolean): Promise<void>;
}
export interface DaytonaSandboxClient {
  create(
    params: { name?: string; language: "python" | "javascript"; autoStopInterval: number; autoDeleteInterval: number },
    options: { timeout: number },
  ): Promise<DaytonaSandboxSession>;
}
export interface DaytonaSandboxSDK {
  Daytona: new (config: {
    apiKey?: string;
    apiUrl?: string;
    otelEnabled: false;
    requestTimeoutMs: number;
  }) => DaytonaSandboxClient;
}
export interface DaytonaSandboxConfig {
  apiKey?: string;
  /** Maps to the current SDK's apiUrl. */
  baseURL?: string;
  /** Optional explicit sandbox name. Omit for a provider-generated unique name. */
  workspace?: string;
  /** Daytona codeRun language is fixed when the sandbox is created. */
  language?: "python" | "node";
  defaultTimeoutSeconds?: number;
  maxOutputBytes?: number;
  /** Borrowed client; created sandboxes are owned and deleted. Client disposal remains the host's responsibility. */
  client?: DaytonaSandboxClient;
  sdk?: DaytonaSandboxSDK;
}
/** @daytona/sdk 0.220.x. SDK imports are lazy and optional. */
export class DaytonaSandbox implements CloudSandbox {
  readonly providerId = "daytona";
  private owner: SandboxSessionOwner<DaytonaSandboxSession>;
  private language: "python" | "node";
  private timeout: number;
  private outputLimit: number;
  private ownedClient?: DaytonaSandboxClient & { [Symbol.asyncDispose]?: () => Promise<void> };
  private closing?: Promise<void>;
  constructor(config: DaytonaSandboxConfig = {}) {
    this.language = config.language ?? "python";
    if (!["python", "node"].includes(this.language)) throw new Error("Unsupported Daytona language");
    this.timeout = sandboxTimeout({}, config.defaultTimeoutSeconds ?? 30);
    this.outputLimit = sandboxOutputLimit(config.maxOutputBytes);
    const snapshot = { ...config };
    this.owner = new SandboxSessionOwner(
      async () => {
        let client = snapshot.client;
        if (!client) {
          let sdk = snapshot.sdk;
          if (!sdk) {
            try {
              sdk = requireSDK("@daytona/sdk") as DaytonaSandboxSDK;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND")
                throw new Error("DaytonaSandbox requires @daytona/sdk ~0.220.0. Install that optional peer.", {
                  cause: error,
                });
              throw error;
            }
          }
          requireSandboxMethods(sdk, ["Daytona"]);
          this.ownedClient ??= new sdk.Daytona({
            apiKey: snapshot.apiKey,
            apiUrl: snapshot.baseURL,
            otelEnabled: false,
            requestTimeoutMs: this.timeout * 1000,
          });
          client = this.ownedClient;
        }
        requireSandboxMethods(client, ["create"]);
        const session = await client
          .create(
            {
              ...(snapshot.workspace ? { name: snapshot.workspace } : {}),
              language: this.language === "node" ? "javascript" : "python",
              autoStopInterval: 5,
              autoDeleteInterval: 0,
            },
            { timeout: this.timeout },
          )
          .catch(async (error: unknown) => {
            try {
              await this.disposeClient();
            } catch (cleanup) {
              throw new AggregateError([error, cleanup], "Daytona creation and client cleanup failed; retry close()");
            }
            throw error;
          });
        return session;
      },
      (session) => session.delete(this.timeout, true),
      (session) =>
        requireSandboxMethods(session, [
          "process.codeRun",
          "process.executeCommand",
          "fs.uploadFile",
          "fs.downloadFile",
          "delete",
        ]),
    );
  }
  start(): Promise<void> {
    return this.owner.start();
  }
  run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    if (options.language === "shell") return this.shell(code, options);
    if ((options.language ?? this.language) !== this.language)
      return Promise.reject(
        new Error(
          "Daytona code language is fixed at creation; configure a separate adapter with the required language",
        ),
      );
    const timeout = sandboxTimeout(options, this.timeout);
    return this.owner.use(async (session) => {
      const result = await session.process.codeRun(code, { env: options.env }, timeout);
      return sandboxResult(result.result, result.exitCode, this.outputLimit);
    }, options.signal);
  }
  shell(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const timeout = sandboxTimeout(options, this.timeout);
    return this.owner.use(async (session) => {
      const result = await session.process.executeCommand(command, undefined, options.env, timeout);
      return sandboxResult(result.result, result.exitCode, this.outputLimit);
    }, options.signal);
  }
  writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    return this.owner.use((session) => session.fs.uploadFile(Buffer.from(contents, encoding), path, this.timeout));
  }
  readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    return this.owner.use(async (session) => {
      try {
        const bytes = await session.fs.downloadFile(path, this.timeout);
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid Daytona file bytes");
        return Buffer.from(bytes).toString(encoding);
      } catch (error) {
        if ((error as { code?: string }).code === "FILE_NOT_FOUND") return null;
        throw error;
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.owner.close();
      await this.disposeClient();
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  private async disposeClient(): Promise<void> {
    const client = this.ownedClient;
    if (client) {
      await client[Symbol.asyncDispose]?.();
      this.ownedClient = undefined;
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
          timeoutSeconds: z.number().positive().max(3600).optional(),
        }),
        execute: async (args: any, ctx) => {
          const r = await sandbox.run(args.code, {
            language: args.language,
            timeoutSeconds: args.timeoutSeconds,
            signal: ctx.signal,
          });
          return JSON.stringify(r);
        },
      },
      {
        name: "sandbox_daytona_shell",
        description: "Run a shell command in the Daytona sandbox.",
        parameters: z.object({ command: z.string(), timeoutSeconds: z.number().positive().max(3600).optional() }),
        execute: async (args: any, ctx) => {
          const r = await sandbox.shell(args.command, { timeoutSeconds: args.timeoutSeconds, signal: ctx.signal });
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
