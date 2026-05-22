import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface FileSystemConfig {
  /** Root directory to restrict file access. All paths are resolved relative to this. */
  basePath?: string;
  /** Allow write operations (write_file). Default false. */
  allowWrite?: boolean;
}

/**
 * File System Toolkit — read, write, list, and inspect local files.
 *
 * All paths are sandboxed to `basePath` if configured, preventing directory traversal.
 *
 * @example
 * ```ts
 * const fsTk = new FileSystemToolkit({ basePath: "./data", allowWrite: true });
 * const agent = new Agent({ tools: [...fsTk.getTools()] });
 * ```
 */
export class FileSystemToolkit extends Toolkit {
  readonly name = "filesystem";
  private basePath: string | undefined;
  private allowWrite: boolean;

  constructor(config: FileSystemConfig = {}) {
    super();
    this.basePath = config.basePath ? path.resolve(config.basePath) : undefined;
    this.allowWrite = config.allowWrite ?? false;
  }

  private resolvePath(filePath: string): string {
    if (!this.basePath) return path.resolve(filePath);

    const resolved = path.resolve(this.basePath, filePath);
    if (!resolved.startsWith(this.basePath)) {
      throw new Error(`Access denied: path "${filePath}" escapes the base directory`);
    }
    return resolved;
  }

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: "fs_read_file",
        description: "Read the contents of a file. Returns the file text.",
        parameters: z.object({
          path: z.string().describe("File path to read"),
          encoding: z.string().optional().describe('Encoding (default "utf-8")'),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const resolved = this.resolvePath(args.path as string);
          const encoding = (args.encoding as BufferEncoding) ?? "utf-8";
          const content = await fs.readFile(resolved, { encoding });
          return content;
        },
      },
      {
        name: "fs_list_directory",
        description: "List files and subdirectories in a directory.",
        parameters: z.object({
          path: z.string().describe("Directory path to list"),
          recursive: z.boolean().optional().describe("List recursively (default false)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const resolved = this.resolvePath(args.path as string);
          const recursive = (args.recursive as boolean) ?? false;
          const entries = await fs.readdir(resolved, { withFileTypes: true, recursive });

          const lines = entries.map((e) => {
            const prefix = e.isDirectory() ? "[dir]  " : "[file] ";
            const rel = e.parentPath ? path.relative(resolved, path.join(e.parentPath, e.name)) : e.name;
            return `${prefix}${rel}`;
          });

          return lines.length > 0 ? lines.join("\n") : "(empty directory)";
        },
      },
      {
        name: "fs_file_info",
        description: "Get metadata about a file or directory (size, modified date, type).",
        parameters: z.object({
          path: z.string().describe("File or directory path"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const resolved = this.resolvePath(args.path as string);
          const stat = await fs.stat(resolved);

          return [
            `Path: ${resolved}`,
            `Type: ${stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"}`,
            `Size: ${stat.size} bytes`,
            `Modified: ${stat.mtime.toISOString()}`,
            `Created: ${stat.birthtime.toISOString()}`,
          ].join("\n");
        },
      },
    ];

    if (this.allowWrite) {
      tools.push({
        name: "fs_write_file",
        description: "Write content to a file. Creates the file if it does not exist, overwrites otherwise.",
        parameters: z.object({
          path: z.string().describe("File path to write"),
          content: z.string().describe("Content to write"),
          append: z.boolean().optional().describe("Append instead of overwrite (default false)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const resolved = this.resolvePath(args.path as string);
          const content = args.content as string;
          const append = (args.append as boolean) ?? false;

          await fs.mkdir(path.dirname(resolved), { recursive: true });

          if (append) {
            await fs.appendFile(resolved, content, "utf-8");
            return `Appended ${content.length} characters to ${resolved}`;
          }

          await fs.writeFile(resolved, content, "utf-8");
          return `Wrote ${content.length} characters to ${resolved}`;
        },
      });
    }

    return tools;
  }
}
