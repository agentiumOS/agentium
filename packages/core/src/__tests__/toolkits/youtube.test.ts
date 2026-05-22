import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubeToolkit } from "../../toolkits/youtube.js";

describe("YouTubeToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns both tools by default", () => {
    const tk = new YouTubeToolkit();
    const tools = tk.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toContain("youtube_transcript");
    expect(tools.map((t) => t.name)).toContain("youtube_search");
  });

  it("can disable search", () => {
    const tk = new YouTubeToolkit({ enableSearch: false });
    const tools = tk.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("youtube_transcript");
  });

  it("can disable transcript", () => {
    const tk = new YouTubeToolkit({ enableTranscript: false });
    const tools = tk.getTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("youtube_search");
  });

  it("extracts video ID from URL", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '"captionTracks":[{"baseUrl":"https://example.com/captions","languageCode":"en"}]',
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<text start="0" dur="5">Hello world</text><text start="5" dur="3">Goodbye</text>',
      } as any);

    const tk = new YouTubeToolkit();
    const tool = tk.getTools().find((t) => t.name === "youtube_transcript")!;
    const result = await tool.execute({ video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, ctx);

    expect(result).toContain("Hello world");
    expect(result).toContain("Goodbye");
  });

  it("search requires API key", async () => {
    const tk = new YouTubeToolkit();
    const tool = tk.getTools().find((t) => t.name === "youtube_search")!;
    await expect(tool.execute({ query: "test" }, ctx)).rejects.toThrow("API key required");
  });

  it("search formats results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            id: { videoId: "abc123" },
            snippet: { title: "Test Video", channelTitle: "Channel", description: "A test" },
          },
        ],
      }),
    } as any);

    const tk = new YouTubeToolkit({ apiKey: "fake-key" });
    const tool = tk.getTools().find((t) => t.name === "youtube_search")!;
    const result = await tool.execute({ query: "test" }, ctx);

    expect(result).toContain("Test Video");
    expect(result).toContain("Channel");
    expect(result).toContain("abc123");
  });
});
