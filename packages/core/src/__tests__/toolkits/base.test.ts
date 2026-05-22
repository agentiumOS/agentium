import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collectToolkitTools, describeToolLibrary, Toolkit } from "../../toolkits/base.js";
import type { ToolDef } from "../../tools/types.js";

class MockToolkit extends Toolkit {
  readonly name = "mock";
  getTools(): ToolDef[] {
    return [
      {
        name: "mock_add",
        description: "Add two numbers",
        parameters: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }: { a: number; b: number }) => String(a + b),
      },
      {
        name: "mock_greet",
        description: "Say hello",
        parameters: z.object({ name: z.string() }),
        execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
      },
    ];
  }
}

class AnotherToolkit extends Toolkit {
  readonly name = "another";
  getTools(): ToolDef[] {
    return [
      {
        name: "another_ping",
        description: "Ping",
        parameters: z.object({}),
        execute: async () => "pong",
      },
    ];
  }
}

describe("collectToolkitTools", () => {
  it("collects tools from multiple toolkits into a keyed record", () => {
    const library = collectToolkitTools([new MockToolkit(), new AnotherToolkit()]);
    expect(Object.keys(library)).toEqual(["mock_add", "mock_greet", "another_ping"]);
    expect(library.mock_add.description).toBe("Add two numbers");
  });

  it("returns empty record for empty array", () => {
    expect(collectToolkitTools([])).toEqual({});
  });

  it("later toolkit overrides earlier if names collide", () => {
    class Override extends Toolkit {
      readonly name = "override";
      getTools(): ToolDef[] {
        return [
          {
            name: "mock_add",
            description: "Overridden",
            parameters: z.object({}),
            execute: async () => "0",
          },
        ];
      }
    }
    const library = collectToolkitTools([new MockToolkit(), new Override()]);
    expect(library.mock_add.description).toBe("Overridden");
  });
});

describe("describeToolLibrary", () => {
  it("returns serializable metadata for each tool", () => {
    const library = collectToolkitTools([new MockToolkit()]);
    const descriptions = describeToolLibrary(library);

    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]).toEqual({
      name: "mock_add",
      description: "Add two numbers",
      parameters: ["a", "b"],
    });
    expect(descriptions[1]).toEqual({
      name: "mock_greet",
      description: "Say hello",
      parameters: ["name"],
    });
  });

  it("returns empty array for empty library", () => {
    expect(describeToolLibrary({})).toEqual([]);
  });
});
