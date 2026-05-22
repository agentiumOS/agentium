import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraToolkit } from "../../toolkits/jira.js";

describe("JiraToolkit", () => {
  const ctx = {} as any;
  const baseUrl = "https://test.atlassian.net";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns five tools", () => {
    const tk = new JiraToolkit({ baseUrl, email: "a@b.com", apiToken: "tok" });
    const tools = tk.getTools();
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "jira_search_issues",
      "jira_get_issue",
      "jira_create_issue",
      "jira_update_issue",
      "jira_add_comment",
    ]);
  });

  it("throws without credentials", async () => {
    const tk = new JiraToolkit({ baseUrl });
    const tool = tk.getTools()[0];
    await expect(tool.execute({ jql: "project = TEST" }, ctx)).rejects.toThrow("email and apiToken required");
  });

  it("search_issues formats results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "Fix the bug",
                status: { name: "Open" },
                priority: { name: "High" },
                assignee: { displayName: "Alice" },
              },
            },
          ],
        }),
    } as any);

    const tk = new JiraToolkit({ baseUrl, email: "a@b.com", apiToken: "tok" });
    const tool = tk.getTools().find((t) => t.name === "jira_search_issues")!;
    const result = await tool.execute({ jql: "project = PROJ" }, ctx);

    expect(result).toContain("PROJ-1");
    expect(result).toContain("Fix the bug");
    expect(result).toContain("Alice");
  });

  it("create_issue returns URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({ key: "PROJ-42" }),
    } as any);

    const tk = new JiraToolkit({ baseUrl, email: "a@b.com", apiToken: "tok" });
    const tool = tk.getTools().find((t) => t.name === "jira_create_issue")!;
    const result = await tool.execute({ project: "PROJ", summary: "New task" }, ctx);

    expect(result).toContain("PROJ-42");
    expect(result).toContain(baseUrl);
  });
});
