import { describe, expect, it } from "vitest";
import { ShellToolkit } from "../../toolkits/shell.js";

describe("ShellToolkit", () => {
  const ctx = {} as any;

  it("returns one tool named shell_exec", () => {
    const tk = new ShellToolkit();
    const tools = tk.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("shell_exec");
  });

  it("executes a simple command", async () => {
    const tk = new ShellToolkit();
    const tool = tk.getTools()[0];
    const result = await tool.execute({ command: "echo hello" }, ctx);
    expect(result).toContain("hello");
    expect(result).toContain("EXIT CODE: 0");
  });

  it("captures stderr on failure", async () => {
    const tk = new ShellToolkit();
    const tool = tk.getTools()[0];
    const result = await tool.execute({ command: "ls /nonexistent_dir_12345" }, ctx);
    expect(result).toContain("STDERR");
  });

  it("enforces allowedCommands", async () => {
    const tk = new ShellToolkit({ allowedCommands: ["echo", "ls"] });
    const tool = tk.getTools()[0];

    const good = await tool.execute({ command: "echo safe" }, ctx);
    expect(good).toContain("safe");

    await expect(tool.execute({ command: "rm -rf /" }, ctx)).rejects.toThrow("Command not allowed");
  });

  it("truncates long output", async () => {
    const tk = new ShellToolkit({ maxOutput: 20 });
    const tool = tk.getTools()[0];
    const result = await tool.execute({ command: "echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'" }, ctx);
    expect(result).toContain("truncated");
  });
});
