import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface JiraConfig {
  /** Jira instance base URL (e.g. "https://yourcompany.atlassian.net"). */
  baseUrl: string;
  /** Atlassian account email for authentication. Falls back to JIRA_EMAIL env var. */
  email?: string;
  /** Jira API token. Falls back to JIRA_API_TOKEN env var. */
  apiToken?: string;
}

/**
 * Jira Toolkit — search, create, and update issues in Jira.
 *
 * Uses Jira REST API v3 with Basic auth (email + API token).
 *
 * @example
 * ```ts
 * const jira = new JiraToolkit({ baseUrl: "https://mycompany.atlassian.net", email: "me@co.com" });
 * const agent = new Agent({ tools: [...jira.getTools()] });
 * ```
 */
export class JiraToolkit extends Toolkit {
  readonly name = "jira";
  private baseUrl: string;
  private emailValue: string | undefined;
  private apiTokenValue: string | undefined;

  constructor(config: JiraConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.emailValue = config.email;
    this.apiTokenValue = config.apiToken;
  }

  private getAuth(): string {
    const email = this.emailValue ?? process.env.JIRA_EMAIL;
    const token = this.apiTokenValue ?? process.env.JIRA_API_TOKEN;
    if (!email || !token) {
      throw new Error(
        "JiraToolkit: email and apiToken required. Set JIRA_EMAIL and JIRA_API_TOKEN env vars or pass in config.",
      );
    }
    return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  }

  private async api(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rest/api/3${path}`, {
      ...options,
      headers: {
        Authorization: this.getAuth(),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string>) ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira API ${res.status}: ${body.slice(0, 300)}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "jira_search_issues",
        description: "Search Jira issues using JQL (Jira Query Language).",
        parameters: z.object({
          jql: z.string().describe('JQL query (e.g. "project = PROJ AND status = Open")'),
          maxResults: z.number().optional().describe("Max results (default 20)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const data = await this.api("/search", {
            method: "POST",
            body: JSON.stringify({
              jql: args.jql,
              maxResults: (args.maxResults as number) ?? 20,
              fields: ["summary", "status", "assignee", "priority", "created"],
            }),
          });

          const issues = data.issues ?? [];
          if (issues.length === 0) return "No issues found.";

          return issues
            .map((i: any) => {
              const f = i.fields;
              return `${i.key}: ${f.summary}\n   Status: ${f.status?.name} | Priority: ${f.priority?.name ?? "None"} | Assignee: ${f.assignee?.displayName ?? "Unassigned"}`;
            })
            .join("\n\n");
        },
      },
      {
        name: "jira_get_issue",
        description: "Get details of a specific Jira issue by key.",
        parameters: z.object({
          issueKey: z.string().describe('Issue key (e.g. "PROJ-123")'),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const issue = await this.api(`/issue/${args.issueKey}`);
          const f = issue.fields;

          const description =
            f.description?.content
              ?.map((block: any) => block.content?.map((c: any) => c.text ?? "").join("") ?? "")
              .join("\n") ?? "(no description)";

          return [
            `${issue.key}: ${f.summary}`,
            `Status: ${f.status?.name}`,
            `Priority: ${f.priority?.name ?? "None"}`,
            `Assignee: ${f.assignee?.displayName ?? "Unassigned"}`,
            `Reporter: ${f.reporter?.displayName ?? "Unknown"}`,
            `Created: ${f.created}`,
            `Type: ${f.issuetype?.name ?? "Unknown"}`,
            `URL: ${this.baseUrl}/browse/${issue.key}`,
            "",
            description,
          ].join("\n");
        },
      },
      {
        name: "jira_create_issue",
        description: "Create a new Jira issue.",
        parameters: z.object({
          project: z.string().describe("Project key (e.g. PROJ)"),
          summary: z.string().describe("Issue title/summary"),
          issueType: z.string().optional().describe('Issue type (default "Task")'),
          description: z.string().optional().describe("Issue description (plain text)"),
          priority: z.string().optional().describe("Priority name (e.g. High, Medium, Low)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const fields: Record<string, unknown> = {
            project: { key: args.project },
            summary: args.summary,
            issuetype: { name: (args.issueType as string) ?? "Task" },
          };

          if (args.description) {
            fields.description = {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: args.description }] }],
            };
          }

          if (args.priority) {
            fields.priority = { name: args.priority };
          }

          const result = await this.api("/issue", {
            method: "POST",
            body: JSON.stringify({ fields }),
          });

          return `Issue created: ${result.key}\nURL: ${this.baseUrl}/browse/${result.key}`;
        },
      },
      {
        name: "jira_update_issue",
        description: "Update fields on an existing Jira issue.",
        parameters: z.object({
          issueKey: z.string().describe("Issue key to update"),
          summary: z.string().optional().describe("New summary/title"),
          status: z.string().optional().describe("New status name (triggers transition)"),
          assignee: z.string().optional().describe("Assignee account ID"),
          priority: z.string().optional().describe("New priority name"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const fields: Record<string, unknown> = {};
          if (args.summary) fields.summary = args.summary;
          if (args.assignee) fields.assignee = { accountId: args.assignee };
          if (args.priority) fields.priority = { name: args.priority };

          if (Object.keys(fields).length > 0) {
            await this.api(`/issue/${args.issueKey}`, {
              method: "PUT",
              body: JSON.stringify({ fields }),
            });
          }

          if (args.status) {
            const transitions = await this.api(`/issue/${args.issueKey}/transitions`);
            const target = transitions.transitions?.find(
              (t: any) => t.name.toLowerCase() === (args.status as string).toLowerCase(),
            );
            if (target) {
              await this.api(`/issue/${args.issueKey}/transitions`, {
                method: "POST",
                body: JSON.stringify({ transition: { id: target.id } }),
              });
            } else {
              return `Issue ${args.issueKey} fields updated, but status transition "${args.status}" not found.`;
            }
          }

          return `Issue ${args.issueKey} updated successfully.`;
        },
      },
      {
        name: "jira_add_comment",
        description: "Add a comment to a Jira issue.",
        parameters: z.object({
          issueKey: z.string().describe("Issue key"),
          comment: z.string().describe("Comment text"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          await this.api(`/issue/${args.issueKey}/comment`, {
            method: "POST",
            body: JSON.stringify({
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: args.comment as string }] }],
              },
            }),
          });

          return `Comment added to ${args.issueKey}.`;
        },
      },
    ];
  }
}
