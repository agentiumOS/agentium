import { expect, expectTypeOf, it } from "vitest";
import * as z3 from "zod-v3";
import * as z4 from "zod-v4";
import * as mini from "zod-v4/mini";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import { defineTool } from "../define-tool.js";
import { convertJsonSchema } from "../json-schema.js";
import { parseSchema, safeParseSchema, schemaShape } from "../schema.js";
import { ToolExecutor } from "../tool-executor.js";

it("infers arguments from current external Zod 4 and keeps transformations at execution", async () => {
  const schema = z4.object({ query: z4.string().trim().min(1), count: z4.number().default(2) });
  const tool = defineTool({
    name: "search",
    description: "search",
    parameters: schema,
    execute: async (args) => {
      expectTypeOf(args.query).toEqualTypeOf<string>();
      expectTypeOf(args.count).toEqualTypeOf<number>();
      return JSON.stringify(args);
    },
  });
  const executor = new ToolExecutor([tool]);
  const context = new RunContext({ sessionId: "schema", eventBus: new EventBus() });
  const [result] = await executor.executeAll([{ id: "1", name: "search", arguments: { query: " hello " } }], context);
  expect(result.result).toBe(JSON.stringify({ query: "hello", count: 2 }));
  const [invalid] = await executor.executeAll([{ id: "2", name: "search", arguments: { query: " " } }], context);
  expect(invalid.error).toBeTruthy();
  expect(convertJsonSchema(schema).schema).toMatchObject({
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
  });
});

it("supports Zod 3 and external Zod 4 Mini through the same public helpers", () => {
  for (const schema of [z3.object({ name: z3.string() }), mini.object({ name: mini.string() })]) {
    defineTool({ name: "greet", description: "greet", parameters: schema, execute: async (args) => args.name });
    expect(schemaShape(schema)).toHaveProperty("name");
    expect(safeParseSchema(schema, { name: 3 }).success).toBe(false);
    expect(parseSchema(schema, { name: "hello" })).toEqual({ name: "hello" });
    expect(convertJsonSchema(schema).schema).toMatchObject({ properties: { name: { type: "string" } } });
  }
});
