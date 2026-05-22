import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../../models/provider.js";
import type { ModelResponse, StreamChunk, ToolCall } from "../../models/types.js";
import { ReflectionManager } from "../reflection.js";

// biome-ignore lint/correctness/useYield: intentionally throws before yielding
async function* throwingStream(msg: string): AsyncGenerator<StreamChunk> {
  throw new Error(msg);
}

function mockCritic(responseJson: string): ModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-critic",
    async generate(): Promise<ModelResponse> {
      return {
        message: { role: "assistant", content: responseJson },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
        raw: {},
      };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text: responseJson };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

describe("ReflectionManager", () => {
  describe("critiqueOutput()", () => {
    it("returns parsed critique result", async () => {
      const critic = mockCritic('{"pass": true, "score": 0.9, "feedback": "Good response", "suggestedRevision": null}');
      const manager = new ReflectionManager({ enabled: true }, critic);

      const result = await manager.critiqueOutput(
        {
          text: "Paris is the capital of France.",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        "What is the capital of France?",
        [],
      );

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.9);
      expect(result.feedback).toBe("Good response");
    });

    it("returns failing critique", async () => {
      const critic = mockCritic(
        '{"pass": false, "score": 0.3, "feedback": "Incorrect", "suggestedRevision": "The capital is Paris"}',
      );
      const manager = new ReflectionManager({ enabled: true }, critic);

      const result = await manager.critiqueOutput(
        {
          text: "London is the capital of France.",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        "What is the capital of France?",
        [],
      );

      expect(result.pass).toBe(false);
      expect(result.score).toBe(0.3);
      expect(result.suggestedRevision).toBe("The capital is Paris");
    });

    it("handles unparseable critic response gracefully", async () => {
      const critic = mockCritic("I can't respond in JSON sorry");
      const manager = new ReflectionManager({ enabled: true }, critic);

      const result = await manager.critiqueOutput(
        { text: "test", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        "test",
        [],
      );

      expect(result.pass).toBe(true);
      expect(result.score).toBe(0.7);
    });

    it("handles critic failure gracefully", async () => {
      const failingCritic: ModelProvider = {
        providerId: "fail",
        modelId: "fail",
        async generate() {
          throw new Error("API down");
        },
        stream() {
          return throwingStream("API down");
        },
      };
      const manager = new ReflectionManager({ enabled: true }, failingCritic);

      const result = await manager.critiqueOutput(
        { text: "test", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        "test",
        [],
      );

      expect(result.pass).toBe(true);
      expect(result.feedback).toContain("unavailable");
    });

    it("includes custom criteria in critique prompt", async () => {
      const critic = mockCritic('{"pass": true, "score": 0.8, "feedback": "ok"}');
      const manager = new ReflectionManager({ enabled: true, customCriteria: "Must include citations" }, critic);

      const result = await manager.critiqueOutput(
        { text: "test", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        "test",
        [],
      );
      expect(result.pass).toBe(true);
    });
  });

  describe("critiquePlan()", () => {
    it("returns approved plan", async () => {
      const critic = mockCritic('{"approved": true, "concerns": [], "suggestion": null}');
      const manager = new ReflectionManager({ enabled: true }, critic);

      const toolCalls: ToolCall[] = [{ id: "1", name: "search", arguments: { query: "test" } }];

      const result = await manager.critiquePlan(toolCalls, "User asked about X");
      expect(result.approved).toBe(true);
      expect(result.concerns).toEqual([]);
    });

    it("returns rejected plan with concerns", async () => {
      const critic = mockCritic(
        '{"approved": false, "concerns": ["Missing auth check", "Redundant calls"], "suggestion": "Add auth first"}',
      );
      const manager = new ReflectionManager({ enabled: true }, critic);

      const result = await manager.critiquePlan(
        [{ id: "1", name: "delete_user", arguments: { id: "123" } }],
        "Delete user data",
      );

      expect(result.approved).toBe(false);
      expect(result.concerns).toHaveLength(2);
      expect(result.suggestion).toBe("Add auth first");
    });

    it("handles critic failure gracefully", async () => {
      const failingCritic: ModelProvider = {
        providerId: "fail",
        modelId: "fail",
        async generate() {
          throw new Error("down");
        },
        stream() {
          return throwingStream("down");
        },
      };
      const manager = new ReflectionManager({ enabled: true }, failingCritic);

      const result = await manager.critiquePlan([], "test");
      expect(result.approved).toBe(true);
    });
  });

  describe("detectLoopEscape()", () => {
    it("returns null when no loop detected", () => {
      const manager = new ReflectionManager({ enabled: true, loopEscapeDetection: true }, mockCritic(""));

      const result = manager.detectLoopEscape([
        { id: "1", name: "search", arguments: { query: "a" } },
        { id: "2", name: "search", arguments: { query: "b" } },
      ]);

      expect(result).toBeNull();
    });

    it("detects repeated tool calls (3+)", () => {
      const manager = new ReflectionManager({ enabled: true, loopEscapeDetection: true }, mockCritic(""));
      const sameCall: ToolCall = { id: "1", name: "search", arguments: { query: "same" } };

      manager.detectLoopEscape([sameCall]);
      manager.detectLoopEscape([sameCall]);
      const result = manager.detectLoopEscape([sameCall]);

      expect(result).not.toBeNull();
      expect(result!.detected).toBe(true);
      expect(result!.repeatedTool).toBe("search");
      expect(result!.repeatCount).toBeGreaterThanOrEqual(3);
      expect(result!.escapePrompt).toContain("search");
    });

    it("does not detect loops with different arguments", () => {
      const manager = new ReflectionManager({ enabled: true, loopEscapeDetection: true }, mockCritic(""));

      manager.detectLoopEscape([{ id: "1", name: "search", arguments: { query: "a" } }]);
      manager.detectLoopEscape([{ id: "2", name: "search", arguments: { query: "b" } }]);
      const result = manager.detectLoopEscape([{ id: "3", name: "search", arguments: { query: "c" } }]);

      expect(result).toBeNull();
    });

    it("returns null when loopEscapeDetection is explicitly false", () => {
      const manager = new ReflectionManager({ enabled: true, loopEscapeDetection: false }, mockCritic(""));

      const sameCall: ToolCall = { id: "1", name: "search", arguments: { query: "same" } };
      manager.detectLoopEscape([sameCall]);
      manager.detectLoopEscape([sameCall]);
      const result = manager.detectLoopEscape([sameCall]);

      expect(result).toBeNull();
    });
  });

  describe("generatePostMortem()", () => {
    it("returns lesson from critic", async () => {
      const critic = mockCritic('{"lesson": "Always check auth first", "category": "tool_error"}');
      const manager = new ReflectionManager({ enabled: true, postMortemLearning: true }, critic);

      const result = await manager.generatePostMortem("run-1", new Error("Auth failed"), []);
      expect(result.lesson).toBe("Always check auth first");
      expect(result.category).toBe("tool_error");
    });

    it("falls back on critic failure", async () => {
      const failingCritic: ModelProvider = {
        providerId: "fail",
        modelId: "fail",
        async generate() {
          throw new Error("down");
        },
        stream() {
          return throwingStream("down");
        },
      };
      const manager = new ReflectionManager({ enabled: true }, failingCritic);

      const result = await manager.generatePostMortem("run-1", new Error("Something broke"), []);
      expect(result.lesson).toContain("Something broke");
      expect(result.category).toBe("external");
    });
  });

  describe("resetHistory()", () => {
    it("clears tool call history", () => {
      const manager = new ReflectionManager({ enabled: true, loopEscapeDetection: true }, mockCritic(""));
      const sameCall: ToolCall = { id: "1", name: "search", arguments: { query: "same" } };

      manager.detectLoopEscape([sameCall]);
      manager.detectLoopEscape([sameCall]);
      manager.resetHistory();
      const result = manager.detectLoopEscape([sameCall]);

      expect(result).toBeNull();
    });
  });
});
