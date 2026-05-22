import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../models/types.js";
import { ContextCurator } from "../context-curator.js";

function buildMessages(): ChatMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Search for revenue data" },
    { role: "tool", content: "[ERROR] Connection timeout. ECONNREFUSED", toolCallId: "tc1" },
    { role: "assistant", content: "Let me try again..." },
    { role: "user", content: "Also find marketing data" },
    { role: "tool", content: "HTTP 500: Internal Server Error", toolCallId: "tc2" },
    { role: "assistant", content: "The server is down..." },
    { role: "user", content: "Try the backup" },
    { role: "tool", content: '{"revenue": "$2.3M", "growth": "15%"}', toolCallId: "tc3" },
    { role: "assistant", content: "Q1 revenue was $2.3M, up 15%." },
    { role: "user", content: "What were the Q4 results?" },
  ];
}

describe("ContextCurator", () => {
  describe("disabled", () => {
    it("returns messages unchanged when disabled", () => {
      const curator = new ContextCurator({ enabled: false });
      const messages = buildMessages();
      const result = curator.curate(messages, "test");
      expect(result).toEqual(messages);
    });
  });

  describe("failedResultHandling: 'remove'", () => {
    it("removes failed tool results", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "remove",
        maxFailedResults: 0,
      });
      const messages = buildMessages();
      const result = curator.curate(messages, "Q4 results");

      const toolMessages = result.filter((m) => m.role === "tool");
      for (const tm of toolMessages) {
        const content = typeof tm.content === "string" ? tm.content : "";
        expect(content).not.toContain("[ERROR]");
        expect(content).not.toContain("HTTP 500");
      }
    });

    it("keeps last N failed results when maxFailedResults > 0", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "remove",
        maxFailedResults: 1,
      });
      const messages = buildMessages();
      const result = curator.curate(messages, "test");

      const failedTools = result.filter(
        (m) => m.role === "tool" && typeof m.content === "string" && /ERROR|HTTP 5/i.test(m.content),
      );
      expect(failedTools.length).toBeLessThanOrEqual(1);
    });
  });

  describe("failedResultHandling: 'deprioritize'", () => {
    it("prefixes excess failed results with warning", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "deprioritize",
        maxFailedResults: 1,
      });
      const messages = buildMessages();
      const result = curator.curate(messages, "test");

      const deprioritized = result.filter(
        (m) => typeof m.content === "string" && m.content.includes("[PREVIOUS ERROR"),
      );
      expect(deprioritized.length).toBeGreaterThan(0);
    });
  });

  describe("failedResultHandling: 'summarize'", () => {
    it("summarizes all failed results to one line", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "summarize",
      });
      const messages = buildMessages();
      const result = curator.curate(messages, "test");

      const summarized = result.filter(
        (m) => typeof m.content === "string" && m.content.includes("[PREVIOUS ERROR - summarized]"),
      );
      expect(summarized.length).toBeGreaterThan(0);

      for (const s of summarized) {
        const content = typeof s.content === "string" ? s.content : "";
        expect(content.length).toBeLessThan(200);
      }
    });
  });

  describe("relevanceDecay", () => {
    it("preserves system messages regardless of decay", () => {
      const curator = new ContextCurator({
        enabled: true,
        relevanceDecay: { enabled: true, halfLifeTurns: 2, minWeight: 0.1 },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `Message ${i}`,
        })),
      ];

      const result = curator.curate(messages, "latest query");
      expect(result.find((m) => m.role === "system")).toBeTruthy();
    });

    it("preserves recent messages", () => {
      const curator = new ContextCurator({
        enabled: true,
        relevanceDecay: { enabled: true, halfLifeTurns: 3, minWeight: 0.05 },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System prompt" },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `Message ${i}`,
        })),
      ];

      const result = curator.curate(messages, "test");
      expect(result.length).toBeLessThan(messages.length);
      expect(result.length).toBeGreaterThan(4);
    });

    it("preserves messages with entity overlap", () => {
      const curator = new ContextCurator({
        enabled: true,
        relevanceDecay: { enabled: true, halfLifeTurns: 2, minWeight: 0.05 },
      });

      const messages: ChatMessage[] = [
        { role: "system", content: "System" },
        { role: "user", content: "Tell me about ProjectAlpha" },
        { role: "assistant", content: "ProjectAlpha is a billing system" },
        ...Array.from({ length: 15 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `Unrelated message ${i}`,
        })),
      ];

      const result = curator.curate(messages, "What about ProjectAlpha?");
      const hasProjectAlpha = result.some((m) => typeof m.content === "string" && m.content.includes("ProjectAlpha"));
      expect(hasProjectAlpha).toBe(true);
    });
  });

  describe("cleanRoomMode", () => {
    it("builds a filtered context view", () => {
      const curator = new ContextCurator({
        enabled: true,
        cleanRoomMode: true,
        failedResultHandling: "remove",
      });

      const messages = buildMessages();
      const result = curator.curate(messages, "Q4 results", { maxRecentMessages: 4 });

      expect(result.length).toBeLessThan(messages.length);
      expect(result[0].role).toBe("system");
    });
  });

  describe("combined strategies", () => {
    it("applies failed handling, reducing message count", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "remove",
        maxFailedResults: 0,
      });

      const messages = buildMessages();
      const result = curator.curate(messages, "Q4");
      expect(result.length).toBeLessThan(messages.length);
    });

    it("applies both failed handling and decay on longer conversations", () => {
      const curator = new ContextCurator({
        enabled: true,
        failedResultHandling: "remove",
        maxFailedResults: 0,
        relevanceDecay: { enabled: true, halfLifeTurns: 3, minWeight: 0.05 },
      });

      const messages = [
        ...buildMessages(),
        ...Array.from({ length: 10 }, (_, i) => ({
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `Filler message ${i}`,
        })),
        { role: "user" as const, content: "What were the Q4 results?" },
      ];

      const result = curator.curate(messages, "Q4");
      expect(result.length).toBeLessThan(messages.length);
    });
  });
});
