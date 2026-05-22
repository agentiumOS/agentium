import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionToolkit } from "../../toolkits/notion.js";

describe("NotionToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns four tools", () => {
    const tk = new NotionToolkit({ token: "ntn_fake" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "notion_search",
      "notion_get_page",
      "notion_create_page",
      "notion_query_database",
    ]);
  });

  it("throws without token", async () => {
    const tk = new NotionToolkit();
    const tool = tk.getTools()[0];
    await expect(tool.execute({ query: "test" }, ctx)).rejects.toThrow("token required");
  });

  it("search formats results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            object: "page",
            id: "abc-123",
            url: "https://notion.so/abc",
            properties: { Name: { title: [{ plain_text: "My Page" }] } },
          },
        ],
      }),
    } as any);

    const tk = new NotionToolkit({ token: "ntn_fake" });
    const tool = tk.getTools().find((t) => t.name === "notion_search")!;
    const result = await tool.execute({ query: "test" }, ctx);

    expect(result).toContain("My Page");
    expect(result).toContain("abc-123");
  });

  it("get_page returns content", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          properties: { title: { title: [{ plain_text: "Test Page" }] } },
          url: "https://notion.so/test",
          last_edited_time: "2025-01-01T00:00:00Z",
        }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ plain_text: "Hello from Notion!" }],
              },
            },
          ],
        }),
      } as any);

    const tk = new NotionToolkit({ token: "ntn_fake" });
    const tool = tk.getTools().find((t) => t.name === "notion_get_page")!;
    const result = await tool.execute({ pageId: "abc-123" }, ctx);

    expect(result).toContain("Test Page");
    expect(result).toContain("Hello from Notion!");
  });

  it("create_page returns URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "new-page-id", url: "https://notion.so/new-page" }),
    } as any);

    const tk = new NotionToolkit({ token: "ntn_fake" });
    const tool = tk.getTools().find((t) => t.name === "notion_create_page")!;
    const result = await tool.execute({ parentId: "db-123", title: "New Page", content: "Body text" }, ctx);

    expect(result).toContain("new-page-id");
  });
});
