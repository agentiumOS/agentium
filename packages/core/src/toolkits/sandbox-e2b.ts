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
export interface E2BSandboxSession {
  runCode(
    code: string,
    options: {
      language: "python" | "javascript";
      envs?: Record<string, string>;
      timeoutMs: number;
      requestTimeoutMs: number;
    },
  ): Promise<{
    logs: { stdout: string[]; stderr: string[] };
    error?: { name: string; value: string; traceback: string };
  }>;
  commands: {
    run(
      command: string,
      options: { timeoutMs: number; envs?: Record<string, string>; signal?: AbortSignal },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  files: {
    write(path: string, data: string | Uint8Array): Promise<unknown>;
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
  };
  kill(): Promise<unknown>;
}
export interface E2BSandboxSDK {
  Sandbox: {
    create(options: {
      apiKey?: string;
      template?: string;
      timeoutMs: number;
      requestTimeoutMs: number;
    }): Promise<E2BSandboxSession>;
  };
}
export interface E2BSandboxConfig {
  apiKey?: string;
  /** Leave unset to use the code-interpreter SDK's language-capable template. */
  template?: string;
  defaultTimeoutSeconds?: number;
  /** Sandbox lifetime; independent of per-operation timeout. Default 300 seconds. */
  lifetimeSeconds?: number;
  maxOutputBytes?: number;
  /** Optional SDK injection. Every created sandbox is owned and killed by this adapter. */
  sdk?: E2BSandboxSDK;
}
/** @e2b/code-interpreter 2.8.x. The optional peer loads only on first use. */
export class E2BSandbox implements CloudSandbox {
  readonly providerId = "e2b";
  private owner: SandboxSessionOwner<E2BSandboxSession>;
  private timeout: number;
  private outputLimit: number;
  constructor(config: E2BSandboxConfig = {}) {
    this.timeout = sandboxTimeout({}, config.defaultTimeoutSeconds ?? 30);
    this.outputLimit = sandboxOutputLimit(config.maxOutputBytes);
    const lifetime = sandboxTimeout({}, config.lifetimeSeconds ?? 300);
    const apiKey = config.apiKey;
    const template = config.template;
    const injected = config.sdk;
    this.owner = new SandboxSessionOwner(
      async () => {
        let sdk = injected;
        if (!sdk) {
          try {
            sdk = requireSDK("@e2b/code-interpreter") as E2BSandboxSDK;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND")
              throw new Error("E2BSandbox requires @e2b/code-interpreter ~2.8.0. Install that optional peer.", {
                cause: error,
              });
            throw error;
          }
        }
        requireSandboxMethods(sdk, ["Sandbox.create"]);
        const session = await sdk.Sandbox.create({
          apiKey,
          ...(template ? { template } : {}),
          timeoutMs: lifetime * 1000,
          requestTimeoutMs: this.timeout * 1000,
        });
        return session;
      },
      async (session) => {
        await session.kill();
      },
      (session) => requireSandboxMethods(session, ["runCode", "commands.run", "files.write", "files.read", "kill"]),
    );
  }
  start(): Promise<void> {
    return this.owner.start();
  }
  run(code: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    if (options.language === "shell") return this.shell(code, options);
    const language = options.language ?? "python";
    if (!["python", "node"].includes(language)) return Promise.reject(new Error("Unsupported E2B language"));
    const timeoutMs = sandboxTimeout(options, this.timeout) * 1000;
    return this.owner.use(async (session) => {
      const result = await session.runCode(code, {
        language: language === "node" ? "javascript" : "python",
        envs: options.env,
        timeoutMs,
        requestTimeoutMs: timeoutMs,
      });
      const error = result.error ? `\n${result.error.name}: ${result.error.value}` : "";
      return sandboxResult(
        result.logs.stdout.join("") + result.logs.stderr.join("") + error,
        result.error ? 1 : 0,
        this.outputLimit,
      );
    }, options.signal);
  }
  shell(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const timeoutMs = sandboxTimeout(options, this.timeout) * 1000;
    return this.owner.use(async (session) => {
      try {
        const result = await session.commands.run(command, { timeoutMs, envs: options.env, signal: options.signal });
        return sandboxResult(result.stdout + result.stderr, result.exitCode, this.outputLimit);
      } catch (error) {
        const result = error as { name?: string; stdout?: string; stderr?: string; exitCode?: number };
        if (
          result.name !== "CommandExitError" ||
          typeof result.stdout !== "string" ||
          typeof result.stderr !== "string" ||
          !Number.isSafeInteger(result.exitCode)
        )
          throw error;
        return sandboxResult(result.stdout + result.stderr, result.exitCode!, this.outputLimit);
      }
    }, options.signal);
  }
  writeFile(path: string, contents: string, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    return this.owner.use(async (session) => {
      await session.files.write(path, Buffer.from(contents, encoding));
    });
  }
  readFile(path: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | null> {
    return this.owner.use(async (session) => {
      try {
        const bytes = await session.files.read(path, { format: "bytes" });
        if (!(bytes instanceof Uint8Array)) throw new Error("Invalid E2B file bytes");
        return Buffer.from(bytes).toString(encoding);
      } catch (error) {
        if ((error as Error).name === "FileNotFoundError") return null;
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return this.owner.close();
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
        name: "sandbox_e2b_shell",
        description: "Run a shell command in the E2B sandbox.",
        parameters: z.object({ command: z.string(), timeoutSeconds: z.number().positive().max(3600).optional() }),
        execute: async (args: any, ctx) => {
          const r = await sandbox.shell(args.command, { timeoutSeconds: args.timeoutSeconds, signal: ctx.signal });
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
