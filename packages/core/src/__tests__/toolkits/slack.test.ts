import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackToolkit } from "../../toolkits/slack.js";

describe("SlackToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns four tools", () => {
    const tk = new SlackToolkit({ token: "xoxb-fake" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "slack_send_message",
      "slack_list_channels",
      "slack_read_messages",
      "slack_reply_thread",
    ]);
  });

  it("throws without token", async () => {
    const tk = new SlackToolkit();
    const tool = tk.getTools()[0];
    await expect(tool.execute({ channel: "#test", text: "hi" }, ctx)).rejects.toThrow("token required");
  });

  it("send_message formats result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, channel: "C123", ts: "123.456" }),
    } as any);

    const tk = new SlackToolkit({ token: "xoxb-fake" });
    const tool = tk.getTools().find((t) => t.name === "slack_send_message")!;
    const result = await tool.execute({ channel: "#test", text: "hello" }, ctx);

    expect(result).toContain("Message sent");
    expect(result).toContain("C123");
  });

  it("list_channels formats output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        channels: [
          { name: "general", id: "C001", num_members: 50, topic: { value: "General chat" } },
          { name: "random", id: "C002", num_members: 30, topic: { value: "" } },
        ],
      }),
    } as any);

    const tk = new SlackToolkit({ token: "xoxb-fake" });
    const tool = tk.getTools().find((t) => t.name === "slack_list_channels")!;
    const result = await tool.execute({}, ctx);

    expect(result).toContain("#general");
    expect(result).toContain("50 members");
  });

  it("read_messages reverses and formats", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        messages: [
          { ts: "1700000002.000", user: "U1", text: "Second" },
          { ts: "1700000001.000", user: "U2", text: "First" },
        ],
      }),
    } as any);

    const tk = new SlackToolkit({ token: "xoxb-fake" });
    const tool = tk.getTools().find((t) => t.name === "slack_read_messages")!;
    const result = await tool.execute({ channel: "C123" }, ctx);

    const firstIdx = (result as string).indexOf("First");
    const secondIdx = (result as string).indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
