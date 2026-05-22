import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSystemToolkit } from "../../toolkits/filesystem.js";

describe("FileSystemToolkit", () => {
  let tmpDir: string;
  const ctx = {} as any;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentium-fs-test-"));
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello, world!");
    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(path.join(tmpDir, "subdir", "nested.txt"), "Nested content");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 3 tools in read-only mode", () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir });
    const tools = tk.getTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["fs_read_file", "fs_list_directory", "fs_file_info"]);
  });

  it("returns 4 tools when allowWrite is true", () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir, allowWrite: true });
    const tools = tk.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toContain("fs_write_file");
  });

  it("reads a file", async () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir });
    const readTool = tk.getTools().find((t) => t.name === "fs_read_file")!;
    const result = await readTool.execute({ path: "hello.txt" }, ctx);
    expect(result).toBe("Hello, world!");
  });

  it("lists a directory", async () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir });
    const listTool = tk.getTools().find((t) => t.name === "fs_list_directory")!;
    const result = await listTool.execute({ path: "." }, ctx);
    expect(result).toContain("hello.txt");
    expect(result).toContain("subdir");
  });

  it("gets file info", async () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir });
    const infoTool = tk.getTools().find((t) => t.name === "fs_file_info")!;
    const result = await infoTool.execute({ path: "hello.txt" }, ctx);
    expect(result).toContain("Type: file");
    expect(result).toContain("Size:");
  });

  it("writes a file", async () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir, allowWrite: true });
    const writeTool = tk.getTools().find((t) => t.name === "fs_write_file")!;
    const result = await writeTool.execute({ path: "new.txt", content: "New file" }, ctx);
    expect(result).toContain("Wrote");
    const content = await fs.readFile(path.join(tmpDir, "new.txt"), "utf-8");
    expect(content).toBe("New file");
  });

  it("blocks path traversal", async () => {
    const tk = new FileSystemToolkit({ basePath: tmpDir });
    const readTool = tk.getTools().find((t) => t.name === "fs_read_file")!;
    await expect(readTool.execute({ path: "../../etc/passwd" }, ctx)).rejects.toThrow("Access denied");
  });
});
