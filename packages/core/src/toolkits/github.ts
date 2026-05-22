import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface GitHubConfig {
  /** GitHub personal access token. Falls back to GITHUB_TOKEN env var. */
  token?: string;
  /** GitHub API base URL (default "https://api.github.com"). Override for GitHub Enterprise. */
  apiBase?: string;
}

/**
 * GitHub Toolkit — interact with GitHub repositories, issues, and pull requests.
 *
 * Requires a GitHub personal access token (classic or fine-grained).
 *
 * @example
 * ```ts
 * const gh = new GitHubToolkit({ token: "ghp_..." });
 * const agent = new Agent({ tools: [...gh.getTools()] });
 * ```
 */
export class GitHubToolkit extends Toolkit {
  readonly name = "github";
  private apiBase: string;
  private tokenValue: string | undefined;

  constructor(config: GitHubConfig = {}) {
    super();
    this.apiBase = (config.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.tokenValue = config.token;
  }

  private getToken(): string {
    const token = this.tokenValue ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GitHubToolkit: token required. Set GITHUB_TOKEN env var or pass token in config.");
    return token;
  }

  private async api(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...((options.headers as Record<string, string>) ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
    }

    return res.json();
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "github_search_repos",
        description: "Search GitHub repositories by query. Returns repo names, descriptions, stars, and URLs.",
        parameters: z.object({
          query: z.string().describe("Search query (e.g. 'machine learning language:python')"),
          maxResults: z.number().optional().describe("Max results (default 10)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const max = (args.maxResults as number) ?? 10;
          const params = new URLSearchParams({ q: args.query as string, per_page: String(max) });
          const data = await this.api(`/search/repositories?${params.toString()}`);

          if (!data.items?.length) return "No repositories found.";

          return data.items
            .map(
              (r: any, i: number) =>
                `${i + 1}. ${r.full_name} (${r.stargazers_count} stars)\n   ${r.description ?? "(no description)"}\n   ${r.html_url}`,
            )
            .join("\n\n");
        },
      },
      {
        name: "github_list_issues",
        description: "List issues for a GitHub repository.",
        parameters: z.object({
          owner: z.string().describe("Repository owner"),
          repo: z.string().describe("Repository name"),
          state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter (default open)"),
          maxResults: z.number().optional().describe("Max results (default 20)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const state = (args.state as string) ?? "open";
          const max = (args.maxResults as number) ?? 20;
          const params = new URLSearchParams({ state, per_page: String(max) });
          const issues = await this.api(`/repos/${args.owner}/${args.repo}/issues?${params.toString()}`);

          if (!issues.length) return "No issues found.";

          return issues
            .filter((i: any) => !i.pull_request)
            .map(
              (i: any) =>
                `#${i.number} [${i.state}] ${i.title}\n   By: ${i.user?.login} | Comments: ${i.comments} | ${i.html_url}`,
            )
            .join("\n\n");
        },
      },
      {
        name: "github_get_issue",
        description: "Get details of a specific GitHub issue including body and labels.",
        parameters: z.object({
          owner: z.string().describe("Repository owner"),
          repo: z.string().describe("Repository name"),
          issueNumber: z.number().describe("Issue number"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const issue = await this.api(`/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}`);
          const labels = (issue.labels ?? []).map((l: any) => l.name).join(", ");

          return [
            `#${issue.number}: ${issue.title}`,
            `State: ${issue.state}`,
            `Author: ${issue.user?.login}`,
            labels ? `Labels: ${labels}` : null,
            `Created: ${issue.created_at}`,
            `URL: ${issue.html_url}`,
            "",
            issue.body ?? "(no body)",
          ]
            .filter((l) => l !== null)
            .join("\n");
        },
      },
      {
        name: "github_create_issue",
        description: "Create a new issue in a GitHub repository.",
        parameters: z.object({
          owner: z.string().describe("Repository owner"),
          repo: z.string().describe("Repository name"),
          title: z.string().describe("Issue title"),
          body: z.string().optional().describe("Issue body (markdown)"),
          labels: z.array(z.string()).optional().describe("Labels to apply"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const issue = await this.api(`/repos/${args.owner}/${args.repo}/issues`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: args.title,
              body: args.body,
              labels: args.labels,
            }),
          });

          return `Issue created: #${issue.number} ${issue.title}\n${issue.html_url}`;
        },
      },
      {
        name: "github_list_prs",
        description: "List pull requests for a GitHub repository.",
        parameters: z.object({
          owner: z.string().describe("Repository owner"),
          repo: z.string().describe("Repository name"),
          state: z.enum(["open", "closed", "all"]).optional().describe("PR state filter (default open)"),
          maxResults: z.number().optional().describe("Max results (default 20)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const state = (args.state as string) ?? "open";
          const max = (args.maxResults as number) ?? 20;
          const params = new URLSearchParams({ state, per_page: String(max) });
          const prs = await this.api(`/repos/${args.owner}/${args.repo}/pulls?${params.toString()}`);

          if (!prs.length) return "No pull requests found.";

          return prs
            .map(
              (pr: any) =>
                `#${pr.number} [${pr.state}] ${pr.title}\n   By: ${pr.user?.login} | ${pr.head?.ref} -> ${pr.base?.ref} | ${pr.html_url}`,
            )
            .join("\n\n");
        },
      },
      {
        name: "github_get_file_content",
        description: "Get the content of a file from a GitHub repository.",
        parameters: z.object({
          owner: z.string().describe("Repository owner"),
          repo: z.string().describe("Repository name"),
          path: z.string().describe("File path within the repository"),
          ref: z.string().optional().describe("Branch, tag, or commit SHA (default: default branch)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const ref = args.ref ? `?ref=${args.ref}` : "";
          const data = await this.api(`/repos/${args.owner}/${args.repo}/contents/${args.path}${ref}`);

          if (Array.isArray(data)) {
            return `Directory listing for ${args.path}:\n${data.map((e: any) => `  ${e.type === "dir" ? "[dir] " : ""}${e.name}`).join("\n")}`;
          }

          if (data.encoding === "base64" && data.content) {
            const content = Buffer.from(data.content, "base64").toString("utf-8");
            return `File: ${data.path} (${data.size} bytes)\n\n${content}`;
          }

          return `File: ${data.path} (${data.size} bytes, encoding: ${data.encoding})`;
        },
      },
    ];
  }
}
