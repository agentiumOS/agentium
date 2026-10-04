import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../agent/agent.js";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { FileSystemToolkit } from "../../toolkits/filesystem.js";

let temp: string;
let base: string;
let outside: string;
const ctx = new RunContext({ sessionId: "test", eventBus: new EventBus() });
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "agentium-boundary-"));
  base = join(temp, "workspace");
  outside = join(temp, "outside");
  await mkdir(base);
  await mkdir(outside);
  await writeFile(join(outside, "data.txt"), "outside");
  await symlink(outside, join(base, "escape"));
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function tool(name: string, write = true) {
  return new FileSystemToolkit({ basePath: base, allowWrite: write }).getTools().find((item) => item.name === name)!;
}

describe("canonical workspace confinement", () => {
  it.each(["fs_read_file", "fs_file_info", "fs_write_file"])("blocks an external link for %s", async (name) => {
    await expect(tool(name).execute({ path: "escape/data.txt", content: "changed" }, ctx)).rejects.toThrow(/outside/);
    expect(await readFile(join(outside, "data.txt"), "utf8")).toBe("outside");
  });
  it("blocks listing and new/append writes under external ancestors", async () => {
    await expect(tool("fs_list_directory").execute({ path: "escape" }, ctx)).rejects.toThrow(/outside/);
    for (const path of ["escape/new/nested.txt", "escape/data.txt"]) {
      await expect(tool("fs_write_file").execute({ path, content: "append", append: true }, ctx)).rejects.toThrow(
        /outside/,
      );
    }
  });
  it("permits internal symlinks and creates nested files atomically", async () => {
    await mkdir(join(base, "inner"));
    await symlink(join(base, "inner"), join(base, "alias"));
    await tool("fs_write_file").execute({ path: "alias/nested/data.txt", content: "first" }, ctx);
    await tool("fs_write_file").execute({ path: "alias/nested/data.txt", content: "second", append: true }, ctx);
    expect(await tool("fs_read_file").execute({ path: "alias/nested/data.txt" }, ctx)).toBe("firstsecond");
  });
  it("rejects a dangling symlink instead of creating its external target", async () => {
    await symlink(join(outside, "missing.txt"), join(base, "dangling"));
    await expect(tool("fs_write_file").execute({ path: "dangling", content: "x" }, ctx)).rejects.toThrow();
  });
  it("requires explicit workspace modes and excludes write tools from read-only access", async () => {
    const model = {
      providerId: "test",
      modelId: "test",
      generate: async () => {
        throw new Error("unused");
      },
      // biome-ignore lint/correctness/useYield: construction-only fixture must fail if a model call occurs.
      stream: async function* () {
        throw new Error("unused");
      },
    };
    const read = new Agent({ name: "read", model, workspace: { path: base, mode: "read" }, register: false });
    const write = new Agent({ name: "write", model, workspace: { path: base, mode: "write" }, register: false });
    expect(() => new Agent({ name: "legacy", model, workspace: base, register: false } as never)).toThrow(/explicit/);
    expect(read.listTools()).not.toContain("fs_write_file");
    expect(write.listTools()).toContain("fs_write_file");
    expect(new FileSystemToolkit({ basePath: base }).getTools().map((t) => t.name)).not.toContain("fs_write_file");
  });
});
