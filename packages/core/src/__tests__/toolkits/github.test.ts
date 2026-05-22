import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubToolkit } from "../../toolkits/github.js";

describe("GitHubToolkit", () => {
  const ctx = {} as any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns six tools", () => {
    const tk = new GitHubToolkit({ token: "fake" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name)).toEqual([
      "github_search_repos",
      "github_list_issues",
      "github_get_issue",
      "github_create_issue",
      "github_list_prs",
      "github_get_file_content",
    ]);
  });

  it("throws without token", async () => {
    const tk = new GitHubToolkit();
    const tool = tk.getTools()[0];
    await expect(tool.execute({ query: "test" }, ctx)).rejects.toThrow("token required");
  });

  it("search_repos formats results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            full_name: "org/repo",
            stargazers_count: 1234,
            description: "A great repo",
            html_url: "https://github.com/org/repo",
          },
        ],
      }),
    } as any);

    const tk = new GitHubToolkit({ token: "fake" });
    const tool = tk.getTools().find((t) => t.name === "github_search_repos")!;
    const result = await tool.execute({ query: "test" }, ctx);

    expect(result).toContain("org/repo");
    expect(result).toContain("1234 stars");
    expect(result).toContain("A great repo");
  });

  it("list_issues filters out PRs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          number: 1,
          state: "open",
          title: "Bug",
          user: { login: "alice" },
          comments: 3,
          html_url: "https://github.com/o/r/issues/1",
        },
        {
          number: 2,
          state: "open",
          title: "PR title",
          user: { login: "bob" },
          comments: 0,
          html_url: "https://github.com/o/r/pull/2",
          pull_request: { url: "..." },
        },
      ],
    } as any);

    const tk = new GitHubToolkit({ token: "fake" });
    const tool = tk.getTools().find((t) => t.name === "github_list_issues")!;
    const result = await tool.execute({ owner: "o", repo: "r" }, ctx);

    expect(result).toContain("#1");
    expect(result).not.toContain("PR title");
  });

  it("get_file_content decodes base64", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        path: "README.md",
        size: 13,
        encoding: "base64",
        content: Buffer.from("Hello, world!").toString("base64"),
      }),
    } as any);

    const tk = new GitHubToolkit({ token: "fake" });
    const tool = tk.getTools().find((t) => t.name === "github_get_file_content")!;
    const result = await tool.execute({ owner: "o", repo: "r", path: "README.md" }, ctx);

    expect(result).toContain("Hello, world!");
  });
});
