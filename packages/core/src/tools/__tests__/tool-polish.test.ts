import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { defineTool } from "../define-tool.js";
import { ToolExecutor } from "../tool-executor.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("Tool polish features", () => {
  describe("inputExamples", () => {
    it("renders examples into the JSON-schema description", () => {
      const tool = defineTool({
        name: "search",
        description: "Search the web.",
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => `q=${query}`,
        inputExamples: [{ query: "tokyo weather" }, { query: "node 22 release notes" }],
      });

      const executor = new ToolExecutor([tool]);
      const defs = executor.getToolDefinitions();
      expect(defs[0].description).toContain("Examples:");
      expect(defs[0].description).toContain("tokyo weather");
      expect(defs[0].description).toContain("node 22 release notes");
    });

    it("omits Examples section when none provided", () => {
      const tool = defineTool({
        name: "ping",
        description: "Ping.",
        parameters: z.object({}),
        execute: async () => "pong",
      });
      const executor = new ToolExecutor([tool]);
      const defs = executor.getToolDefinitions();
      expect(defs[0].description).toBe("Ping.");
    });
  });

  describe("toModelOutput", () => {
    it("transforms the result before it is returned", async () => {
      const tool = defineTool({
        name: "fetchData",
        description: "x",
        parameters: z.object({}),
        execute: async () => "raw-output-large-payload",
        toModelOutput: async (result) => {
          const content = typeof result === "string" ? result : result.content;
          return `summary: ${content.slice(0, 8)}`;
        },
      });

      const executor = new ToolExecutor([tool]);
      const ctx = makeCtx();
      const [result] = await executor.executeAll([{ id: "c1", name: "fetchData", arguments: {} }], ctx);
      expect(result.result).toBe("summary: raw-outp");
    });

    it("runs before artifact auto-conversion", async () => {
      const tool = defineTool({
        name: "fetchData",
        description: "x",
        parameters: z.object({}),
        execute: async () => "x".repeat(200_000), // would normally be wrapped
        toModelOutput: async (_result) => "compressed",
      });
      const executor = new ToolExecutor([tool], { artifacts: { maxToolOutputBytes: 1024, previewChars: 50 } });
      const ctx = makeCtx();
      const [result] = await executor.executeAll([{ id: "c1", name: "fetchData", arguments: {} }], ctx);
      // toModelOutput shrunk it below the threshold so artifact-conversion is skipped
      expect(result.result).toBe("compressed");
    });
  });

  describe("strict mode", () => {
    it("emits additionalProperties: false when strict is true", () => {
      const tool = defineTool({
        name: "strict",
        description: "x",
        parameters: z.object({ x: z.number() }),
        execute: async () => "ok",
        strict: true,
      });
      const executor = new ToolExecutor([tool]);
      const defs = executor.getToolDefinitions();
      expect(defs[0]).toHaveProperty("strict", true);
      expect(defs[0].parameters.additionalProperties).toBe(false);
    });

    it("does not set strict when not requested", () => {
      const tool = defineTool({
        name: "loose",
        description: "x",
        parameters: z.object({ x: z.number() }),
        execute: async () => "ok",
      });
      const executor = new ToolExecutor([tool]);
      const defs = executor.getToolDefinitions();
      expect(defs[0].strict).toBeUndefined();
    });
  });
});
