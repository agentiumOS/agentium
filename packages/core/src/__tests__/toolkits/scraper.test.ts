import { afterEach, describe, expect, it, vi } from "vitest";
import { ScraperToolkit } from "../../toolkits/scraper.js";

describe("ScraperToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns two tools", () => {
    const tk = new ScraperToolkit();
    const tools = tk.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(["scrape_url", "scrape_links"]);
  });

  it("strips HTML tags from page content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () => "<html><body><p>Hello <b>world</b></p><script>evil()</script></body></html>",
    } as any);

    const tk = new ScraperToolkit();
    const tool = tk.getTools().find((t) => t.name === "scrape_url")!;
    const result = await tool.execute({ url: "https://example.com" }, ctx);

    expect(result).toContain("Hello world");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("evil()");
  });

  it("extracts links from HTML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () => '<html><body><a href="https://foo.com">Foo</a><a href="/bar">Bar</a></body></html>',
    } as any);

    const tk = new ScraperToolkit();
    const tool = tk.getTools().find((t) => t.name === "scrape_links")!;
    const result = await tool.execute({ url: "https://example.com" }, ctx);

    expect(result).toContain("Foo");
    expect(result).toContain("https://foo.com");
    expect(result).toContain("Bar");
    expect(result).toContain("https://example.com/bar");
  });

  it("truncates long content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () => `<p>${"a".repeat(500)}</p>`,
    } as any);

    const tk = new ScraperToolkit({ maxLength: 50 });
    const tool = tk.getTools().find((t) => t.name === "scrape_url")!;
    const result = await tool.execute({ url: "https://example.com" }, ctx);

    expect(result).toContain("truncated");
  });
});
