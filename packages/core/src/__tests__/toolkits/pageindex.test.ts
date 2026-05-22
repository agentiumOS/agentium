import { describe, expect, it } from "vitest";
import { toolkitCatalog } from "../../toolkits/catalog.js";
import { PageIndexToolkit } from "../../toolkits/pageindex.js";

describe("PageIndexToolkit", () => {
  it("returns 7 tools", () => {
    const tk = new PageIndexToolkit({ apiKey: "test-key" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name)).toEqual([
      "pageindex_submit",
      "pageindex_status",
      "pageindex_tree",
      "pageindex_list",
      "pageindex_chat",
      "pageindex_retrieve",
      "pageindex_delete",
    ]);
  });

  it("all tools have descriptions and parameters", () => {
    const tk = new PageIndexToolkit({ apiKey: "test-key" });
    for (const tool of tk.getTools()) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters).toBeDefined();
    }
  });

  it("has name 'pageindex'", () => {
    const tk = new PageIndexToolkit({ apiKey: "test-key" });
    expect(tk.name).toBe("pageindex");
  });

  it("throws without API key on list", async () => {
    const tk = new PageIndexToolkit();
    const listTool = tk.getTools().find((t) => t.name === "pageindex_list")!;
    await expect(listTool.execute({}, {} as any)).rejects.toThrow(/API key/);
  });

  it("is registered in the toolkit catalog", () => {
    expect(toolkitCatalog.has("pageindex")).toBe(true);
    const meta = toolkitCatalog.get("pageindex");
    expect(meta?.name).toBe("PageIndex");
    expect(meta?.requiresCredentials).toBe(true);
  });
});
