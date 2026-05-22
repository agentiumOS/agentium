import { afterEach, describe, expect, it, vi } from "vitest";
import { WikipediaToolkit } from "../../toolkits/wikipedia.js";

describe("WikipediaToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns two tools", () => {
    const tk = new WikipediaToolkit();
    const tools = tk.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["wikipedia_search", "wikipedia_summary"]);
  });

  it("search formats results correctly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: {
          search: [
            { title: "Node.js", snippet: "A <b>JavaScript</b> runtime" },
            { title: "Deno", snippet: "A secure runtime" },
          ],
        },
      }),
    } as any);

    const tk = new WikipediaToolkit();
    const tool = tk.getTools().find((t) => t.name === "wikipedia_search")!;
    const result = await tool.execute({ query: "javascript runtime" }, ctx);

    expect(result).toContain("1. Node.js");
    expect(result).toContain("2. Deno");
    expect(result).toContain("A JavaScript runtime");
  });

  it("summary returns article extract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: "TypeScript",
        description: "Programming language",
        extract: "TypeScript is a typed superset of JavaScript.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/TypeScript" } },
      }),
    } as any);

    const tk = new WikipediaToolkit();
    const tool = tk.getTools().find((t) => t.name === "wikipedia_summary")!;
    const result = await tool.execute({ title: "TypeScript" }, ctx);

    expect(result).toContain("Title: TypeScript");
    expect(result).toContain("typed superset");
  });

  it("respects language config", () => {
    const tk = new WikipediaToolkit({ language: "fr" });
    expect(tk.name).toBe("wikipedia");
  });
});
