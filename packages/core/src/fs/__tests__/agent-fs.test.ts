import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { AgentFileSystem } from "../agent-fs.js";

describe("AgentFileSystem", () => {
  const ctx = { userId: "u1", agentId: "helper", sessionId: "s1" };

  it("writes, reads, lists, and searches notes", async () => {
    const fs = new AgentFileSystem({ storage: new InMemoryStorage() });
    await fs.writeFile("notes/todo.md", "buy milk", ctx);
    const file = await fs.readFile("notes/todo.md", ctx);
    expect(file?.content).toBe("buy milk");
    expect(await fs.listFiles(ctx)).toEqual(["notes/todo.md"]);
    const hits = await fs.searchContent("milk", ctx);
    expect(hits[0].path).toBe("notes/todo.md");
  });

  it("rejects path traversal", async () => {
    const fs = new AgentFileSystem();
    await expect(fs.writeFile("../secret", "x", ctx)).rejects.toThrow(/Invalid path/);
  });

  it("bumps version on overwrite", async () => {
    const fs = new AgentFileSystem();
    const v1 = await fs.writeFile("a.md", "one", ctx);
    const v2 = await fs.writeFile("a.md", "two", ctx);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });
});
