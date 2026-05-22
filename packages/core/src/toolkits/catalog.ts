import type { Toolkit } from "./base.js";
import { CalculatorToolkit } from "./calculator.js";
import { GoogleCalendarToolkit } from "./calendar.js";
import { CodeInterpreterToolkit } from "./code-interpreter.js";
import { DiscordToolkit } from "./discord.js";
import { DuckDuckGoToolkit } from "./duckduckgo.js";
import { FileSystemToolkit } from "./filesystem.js";
import { GitToolkit } from "./git.js";
import { GitHubToolkit } from "./github.js";
import { GmailToolkit } from "./gmail.js";
import { GoogleSheetsToolkit } from "./google-sheets.js";
import { GoogleWorkspaceToolkit } from "./google-workspace.js";
import { HackerNewsToolkit } from "./hackernews.js";
import { HttpToolkit } from "./http.js";
import { ImageGenerationToolkit } from "./image-generation.js";
import { JiraToolkit } from "./jira.js";
import { NotionToolkit } from "./notion.js";
import { PageIndexToolkit } from "./pageindex.js";
import { PdfToolkit } from "./pdf.js";
import { RedisToolkit } from "./redis.js";
import { S3Toolkit } from "./s3.js";
import { ScraperToolkit } from "./scraper.js";
import { ShellToolkit } from "./shell.js";
import { SlackToolkit } from "./slack.js";
import { SqlToolkit } from "./sql.js";
import { StripeToolkit } from "./stripe.js";
import { TelegramToolkit } from "./telegram.js";
import { WebSearchToolkit } from "./websearch.js";
import { WhatsAppToolkit } from "./whatsapp.js";
import { WikipediaToolkit } from "./wikipedia.js";
import { YouTubeToolkit } from "./youtube.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ToolkitConfigField {
  /** Machine-readable name matching the config interface property. */
  name: string;
  /** Human-readable label for the UI. */
  label: string;
  type: "string" | "number" | "boolean" | "select";
  /** Field is required to instantiate the toolkit. */
  required?: boolean;
  /** Field contains a secret (API key, token) — mask in responses. */
  secret?: boolean;
  /** Environment variable fallback name. */
  envVar?: string;
  default?: unknown;
  /** Options for "select" type. */
  options?: string[];
  /** Help text shown under the field. */
  hint?: string;
}

export interface ToolkitMeta {
  /** Unique identifier (e.g. "github", "slack"). */
  id: string;
  /** Display name (e.g. "GitHub", "Slack"). */
  name: string;
  description: string;
  category: "utility" | "search" | "api" | "enterprise" | "communication" | "iot";
  /** Whether the toolkit needs credentials / API keys to work. */
  requiresCredentials: boolean;
  configFields: ToolkitConfigField[];
  /** Create a live Toolkit instance from a config object. */
  factory: (config: Record<string, unknown>) => Toolkit;
}

/* ------------------------------------------------------------------ */
/*  Catalog                                                            */
/* ------------------------------------------------------------------ */

const entries: ToolkitMeta[] = [
  /* ── Utilities (no credentials) ─────────────────────────────────── */

  {
    id: "calculator",
    name: "Calculator",
    description: "Safe mathematical expression evaluation",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      {
        name: "precision",
        label: "Decimal Precision",
        type: "number",
        default: 10,
        hint: "Number of decimal places in results",
      },
    ],
    factory: (c) => new CalculatorToolkit(c as any),
  },
  {
    id: "filesystem",
    name: "File System",
    description: "Read, write, and list files within a sandboxed directory",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      { name: "basePath", label: "Base Path", type: "string", hint: "Root directory for sandboxing (absolute path)" },
      { name: "allowWrite", label: "Allow Write", type: "boolean", default: false },
    ],
    factory: (c) => new FileSystemToolkit(c as any),
  },
  {
    id: "shell",
    name: "Shell",
    description: "Execute shell commands with timeout and allowlisting",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      { name: "timeout", label: "Timeout (ms)", type: "number", default: 30000 },
      { name: "maxOutput", label: "Max Output Chars", type: "number", default: 10000 },
      { name: "cwd", label: "Working Directory", type: "string" },
    ],
    factory: (c) => new ShellToolkit(c as any),
  },

  /* ── Search / Web (no credentials or free) ──────────────────────── */

  {
    id: "wikipedia",
    name: "Wikipedia",
    description: "Search and summarize Wikipedia articles",
    category: "search",
    requiresCredentials: false,
    configFields: [
      { name: "language", label: "Language", type: "string", default: "en", hint: "Wikipedia language code" },
      { name: "maxResults", label: "Max Results", type: "number", default: 5 },
    ],
    factory: (c) => new WikipediaToolkit(c as any),
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    description: "Web and news search via DuckDuckGo",
    category: "search",
    requiresCredentials: false,
    configFields: [
      { name: "enableSearch", label: "Enable Web Search", type: "boolean", default: true },
      { name: "enableNews", label: "Enable News Search", type: "boolean", default: true },
      { name: "maxResults", label: "Max Results", type: "number", default: 5 },
    ],
    factory: (c) => new DuckDuckGoToolkit(c as any),
  },
  {
    id: "hackernews",
    name: "Hacker News",
    description: "Fetch top stories and user details from Hacker News",
    category: "search",
    requiresCredentials: false,
    configFields: [
      { name: "enableGetTopStories", label: "Enable Top Stories", type: "boolean", default: true },
      { name: "enableGetUserDetails", label: "Enable User Details", type: "boolean", default: true },
    ],
    factory: (c) => new HackerNewsToolkit(c as any),
  },
  {
    id: "scraper",
    name: "Web Scraper",
    description: "Extract text content and links from web pages",
    category: "search",
    requiresCredentials: false,
    configFields: [
      { name: "maxLength", label: "Max Text Length", type: "number", default: 15000 },
      { name: "timeout", label: "Timeout (ms)", type: "number", default: 15000 },
    ],
    factory: (c) => new ScraperToolkit(c as any),
  },
  {
    id: "http",
    name: "HTTP Client",
    description: "Make HTTP requests (GET, POST, PUT, PATCH, DELETE)",
    category: "api",
    requiresCredentials: false,
    configFields: [
      { name: "baseUrl", label: "Base URL", type: "string", hint: "Prepended to relative paths" },
      { name: "timeout", label: "Timeout (ms)", type: "number", default: 30000 },
    ],
    factory: (c) => new HttpToolkit(c as any),
  },

  /* ── API-key services ───────────────────────────────────────────── */

  {
    id: "websearch",
    name: "Web Search",
    description: "Search the web via Tavily or SerpAPI",
    category: "search",
    requiresCredentials: true,
    configFields: [
      { name: "provider", label: "Provider", type: "select", required: true, options: ["tavily", "serpapi"] },
      {
        name: "apiKey",
        label: "API Key",
        type: "string",
        required: true,
        secret: true,
        envVar: "TAVILY_API_KEY",
        hint: "Tavily key or SerpAPI key depending on provider",
      },
      { name: "maxResults", label: "Max Results", type: "number", default: 5 },
    ],
    factory: (c) => new WebSearchToolkit(c as any),
  },
  {
    id: "youtube",
    name: "YouTube",
    description: "Video transcript extraction and search",
    category: "api",
    requiresCredentials: false,
    configFields: [
      {
        name: "apiKey",
        label: "YouTube Data API Key",
        type: "string",
        secret: true,
        envVar: "YOUTUBE_API_KEY",
        hint: "Only needed for video search; transcripts are free",
      },
      { name: "enableSearch", label: "Enable Search", type: "boolean", default: true },
      { name: "enableTranscript", label: "Enable Transcript", type: "boolean", default: true },
    ],
    factory: (c) => new YouTubeToolkit(c as any),
  },
  {
    id: "sql",
    name: "SQL Database",
    description: "Query SQLite, PostgreSQL, or MySQL databases",
    category: "api",
    requiresCredentials: true,
    configFields: [
      {
        name: "dialect",
        label: "Database Dialect",
        type: "select",
        required: true,
        options: ["sqlite", "postgres", "mysql"],
      },
      {
        name: "connectionString",
        label: "Connection String",
        type: "string",
        required: true,
        secret: true,
        hint: "File path (sqlite) or URI (postgres://user:pass@host/db)",
      },
      { name: "readOnly", label: "Read Only", type: "boolean", default: true },
      { name: "maxRows", label: "Max Rows", type: "number", default: 100 },
    ],
    factory: (c) => new SqlToolkit(c as any),
  },

  /* ── Enterprise integrations ────────────────────────────────────── */

  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, PRs, and file content via GitHub API",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "token",
        label: "Personal Access Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "GITHUB_TOKEN",
      },
      {
        name: "apiBase",
        label: "API Base URL",
        type: "string",
        default: "https://api.github.com",
        hint: "Override for GitHub Enterprise",
      },
    ],
    factory: (c) => new GitHubToolkit(c as any),
  },
  {
    id: "slack",
    name: "Slack",
    description: "Send messages, list channels, read threads",
    category: "communication",
    requiresCredentials: true,
    configFields: [
      {
        name: "token",
        label: "Bot User OAuth Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "SLACK_BOT_TOKEN",
        hint: "Requires scopes: chat:write, channels:read, channels:history",
      },
    ],
    factory: (c) => new SlackToolkit(c as any),
  },
  {
    id: "jira",
    name: "Jira",
    description: "Search, create, update issues and add comments",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "baseUrl",
        label: "Jira Base URL",
        type: "string",
        required: true,
        hint: "e.g. https://yourorg.atlassian.net",
      },
      { name: "email", label: "Atlassian Email", type: "string", required: true, envVar: "JIRA_EMAIL" },
      { name: "apiToken", label: "API Token", type: "string", required: true, secret: true, envVar: "JIRA_API_TOKEN" },
    ],
    factory: (c) => new JiraToolkit(c as any),
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, and create pages and query databases",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "token",
        label: "Integration Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "NOTION_API_KEY",
      },
    ],
    factory: (c) => new NotionToolkit(c as any),
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Send messages and media via WhatsApp Business API",
    category: "communication",
    requiresCredentials: true,
    configFields: [
      {
        name: "accessToken",
        label: "Access Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "WHATSAPP_ACCESS_TOKEN",
      },
      {
        name: "phoneNumberId",
        label: "Phone Number ID",
        type: "string",
        required: true,
        envVar: "WHATSAPP_PHONE_NUMBER_ID",
      },
      { name: "version", label: "API Version", type: "string", default: "v22.0" },
    ],
    factory: (c) => new WhatsAppToolkit(c as any),
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Send, read, and search emails via Gmail API",
    category: "communication",
    requiresCredentials: true,
    configFields: [
      {
        name: "credentialsPath",
        label: "OAuth Credentials Path",
        type: "string",
        secret: true,
        envVar: "GMAIL_CREDENTIALS_PATH",
      },
      { name: "tokenPath", label: "Token Path", type: "string", secret: true, envVar: "GMAIL_TOKEN_PATH" },
    ],
    factory: (c) => new GmailToolkit(c as any),
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    description: "List, create, get, and delete calendar events",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "credentialsPath",
        label: "OAuth Credentials Path",
        type: "string",
        secret: true,
        envVar: "GOOGLE_CALENDAR_CREDENTIALS_PATH",
      },
      { name: "tokenPath", label: "Token Path", type: "string", secret: true, envVar: "GOOGLE_CALENDAR_TOKEN_PATH" },
      { name: "calendarId", label: "Calendar ID", type: "string", default: "primary" },
    ],
    factory: (c) => new GoogleCalendarToolkit(c as any),
  },

  /* ── New Toolkits ────────────────────────────────────────────────── */

  {
    id: "pdf",
    name: "PDF",
    description: "Extract text, metadata, and page content from PDF files",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      {
        name: "maxLength",
        label: "Max Text Length",
        type: "number",
        default: 50000,
        hint: "Maximum characters to return per extraction",
      },
    ],
    factory: (c) => new PdfToolkit(c as any),
  },
  {
    id: "google_sheets",
    name: "Google Sheets",
    description: "Read, write, and append data in Google Sheets",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "credentialsPath",
        label: "OAuth Credentials Path",
        type: "string",
        secret: true,
        envVar: "GOOGLE_SHEETS_CREDENTIALS_PATH",
      },
      { name: "tokenPath", label: "Token Path", type: "string", secret: true, envVar: "GOOGLE_SHEETS_TOKEN_PATH" },
      {
        name: "spreadsheetId",
        label: "Spreadsheet ID",
        type: "string",
        envVar: "GOOGLE_SHEETS_SPREADSHEET_ID",
        hint: "From the spreadsheet URL",
      },
    ],
    factory: (c) => new GoogleSheetsToolkit(c as any),
  },
  {
    id: "redis",
    name: "Redis",
    description: "Get, set, delete, list, and increment keys in Redis",
    category: "api",
    requiresCredentials: true,
    configFields: [
      {
        name: "url",
        label: "Redis URL",
        type: "string",
        secret: true,
        envVar: "REDIS_URL",
        default: "redis://localhost:6379",
      },
      { name: "keyPrefix", label: "Key Prefix", type: "string", hint: "Namespace prefix for all keys" },
      { name: "maxKeys", label: "Max Keys", type: "number", default: 100 },
    ],
    factory: (c) => new RedisToolkit(c as any),
  },
  {
    id: "code_interpreter",
    name: "Code Interpreter",
    description: "Execute JavaScript, Python, or TypeScript code in a sandboxed subprocess",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      { name: "timeout", label: "Timeout (ms)", type: "number", default: 30000 },
      { name: "maxOutput", label: "Max Output Chars", type: "number", default: 10000 },
      { name: "cwd", label: "Working Directory", type: "string", hint: "Directory for script execution" },
    ],
    factory: (c) => new CodeInterpreterToolkit(c as any),
  },
  {
    id: "git",
    name: "Git",
    description: "Local git operations: status, diff, log, commit, branch",
    category: "utility",
    requiresCredentials: false,
    configFields: [
      { name: "cwd", label: "Repository Path", type: "string", hint: "Working directory for git commands" },
      { name: "maxOutput", label: "Max Output Chars", type: "number", default: 10000 },
    ],
    factory: (c) => new GitToolkit(c as any),
  },
  {
    id: "s3",
    name: "S3 Cloud Storage",
    description: "Upload, download, list, delete, and presign URLs for S3-compatible storage",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      { name: "bucket", label: "Bucket Name", type: "string", envVar: "S3_BUCKET" },
      { name: "region", label: "AWS Region", type: "string", default: "us-east-1", envVar: "AWS_REGION" },
      {
        name: "endpoint",
        label: "Custom Endpoint",
        type: "string",
        hint: "For MinIO, R2, or GCS S3-compatible endpoints",
      },
      { name: "accessKeyId", label: "Access Key ID", type: "string", secret: true, envVar: "AWS_ACCESS_KEY_ID" },
      {
        name: "secretAccessKey",
        label: "Secret Access Key",
        type: "string",
        secret: true,
        envVar: "AWS_SECRET_ACCESS_KEY",
      },
      { name: "forcePathStyle", label: "Force Path Style", type: "boolean", default: false, hint: "Enable for MinIO" },
    ],
    factory: (c) => new S3Toolkit(c as any),
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Send messages, photos, and read updates via Telegram Bot API",
    category: "communication",
    requiresCredentials: true,
    configFields: [
      {
        name: "botToken",
        label: "Bot Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "TELEGRAM_BOT_TOKEN",
        hint: "Token from @BotFather",
      },
    ],
    factory: (c) => new TelegramToolkit(c as any),
  },
  {
    id: "discord",
    name: "Discord",
    description: "Send messages, read messages, and list channels in Discord servers",
    category: "communication",
    requiresCredentials: true,
    configFields: [
      {
        name: "botToken",
        label: "Bot Token",
        type: "string",
        required: true,
        secret: true,
        envVar: "DISCORD_BOT_TOKEN",
      },
    ],
    factory: (c) => new DiscordToolkit(c as any),
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "List charges, get customers, create refunds, list subscriptions, and get invoices",
    category: "enterprise",
    requiresCredentials: true,
    configFields: [
      {
        name: "secretKey",
        label: "Secret Key",
        type: "string",
        required: true,
        secret: true,
        envVar: "STRIPE_SECRET_KEY",
      },
      { name: "maxItems", label: "Max Items", type: "number", default: 25 },
    ],
    factory: (c) => new StripeToolkit(c as any),
  },
  {
    id: "image_generation",
    name: "Image Generation",
    description: "Generate and edit images via OpenAI DALL-E API",
    category: "api",
    requiresCredentials: true,
    configFields: [
      {
        name: "apiKey",
        label: "OpenAI API Key",
        type: "string",
        required: true,
        secret: true,
        envVar: "OPENAI_API_KEY",
      },
      { name: "model", label: "Model", type: "select", default: "dall-e-3", options: ["dall-e-2", "dall-e-3"] },
      {
        name: "size",
        label: "Default Size",
        type: "select",
        default: "1024x1024",
        options: ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"],
      },
      { name: "quality", label: "Quality", type: "select", default: "standard", options: ["standard", "hd"] },
    ],
    factory: (c) => new ImageGenerationToolkit(c as any),
  },
  {
    id: "pageindex",
    name: "PageIndex",
    description: "Vectorless, reasoning-based RAG — submit PDFs, build tree indexes, and retrieve via LLM reasoning",
    category: "api",
    requiresCredentials: true,
    configFields: [
      {
        name: "apiKey",
        label: "API Key",
        type: "string",
        required: true,
        secret: true,
        envVar: "PAGEINDEX_API_KEY",
        hint: "Get your key at dash.pageindex.ai",
      },
      {
        name: "apiBase",
        label: "API Base URL",
        type: "string",
        default: "https://api.pageindex.ai",
        hint: "Override for self-hosted PageIndex",
      },
      { name: "timeout", label: "Timeout (ms)", type: "number", default: 120000 },
    ],
    factory: (c) => new PageIndexToolkit(c as any),
  },

  /* ── Google Workspace (all-in-one via gws CLI MCP) ──────────────── */

  {
    id: "google_workspace",
    name: "Google Workspace",
    description:
      "All-in-one access to 30+ Google Workspace APIs (Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and more) via the gws CLI MCP server",
    category: "enterprise",
    requiresCredentials: false,
    configFields: [
      {
        name: "services",
        label: "Services",
        type: "string",
        default: "drive,gmail,calendar,sheets",
        hint: 'Comma-separated list of Google Workspace services to enable. Use "all" for everything.',
      },
      {
        name: "gwsBinaryPath",
        label: "gws Binary Path",
        type: "string",
        default: "gws",
        hint: "Path to the gws binary if not on PATH. Install: npm install -g @googleworkspace/cli",
      },
      {
        name: "includeWorkflows",
        label: "Include Workflows",
        type: "boolean",
        default: false,
        hint: "Include higher-level workflow tools (e.g., gmail send, drive upload)",
      },
      {
        name: "includeHelpers",
        label: "Include Helpers",
        type: "boolean",
        default: false,
        hint: "Include helper tools for common multi-step operations",
      },
    ],
    factory: (c) =>
      new GoogleWorkspaceToolkit({
        services: typeof c.services === "string" ? c.services.split(",").map((s: string) => s.trim()) : undefined,
        gwsBinaryPath: c.gwsBinaryPath as string | undefined,
        includeWorkflows: c.includeWorkflows as boolean | undefined,
        includeHelpers: c.includeHelpers as boolean | undefined,
      }),
  },
];

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Registry of all built-in toolkit types.
 *
 * Use `toolkitCatalog.list()` to get metadata for the UI,
 * and `toolkitCatalog.create(id, config)` to instantiate a toolkit.
 *
 * @example
 * ```ts
 * const all = toolkitCatalog.list();
 * // UI: show toolkit cards with configFields
 *
 * const tk = toolkitCatalog.create("github", { token: "ghp_..." });
 * // tk is a live GitHubToolkit
 * ```
 */
export class ToolkitCatalog {
  private readonly registry = new Map<string, ToolkitMeta>();

  constructor(items: ToolkitMeta[] = entries) {
    for (const item of items) {
      this.registry.set(item.id, item);
    }
  }

  /** List all available toolkit types with their config requirements. */
  list(): Omit<ToolkitMeta, "factory">[] {
    return Array.from(this.registry.values()).map(({ factory: _f, ...rest }) => rest);
  }

  /** Get a single toolkit descriptor by id. */
  get(id: string): Omit<ToolkitMeta, "factory"> | undefined {
    const meta = this.registry.get(id);
    if (!meta) return undefined;
    const { factory: _f, ...rest } = meta;
    return rest;
  }

  /** Check if a toolkit id exists. */
  has(id: string): boolean {
    return this.registry.has(id);
  }

  /** Create a live Toolkit instance from a config object. */
  create(id: string, config: Record<string, unknown> = {}): Toolkit {
    const meta = this.registry.get(id);
    if (!meta) {
      throw new Error(`Unknown toolkit "${id}". Available: ${Array.from(this.registry.keys()).join(", ")}`);
    }
    return meta.factory(config);
  }

  /** Register a custom toolkit type (for user-defined toolkits). */
  register(meta: ToolkitMeta): void {
    this.registry.set(meta.id, meta);
  }
}

/** Global toolkit catalog instance with all built-in toolkits. */
export const toolkitCatalog = new ToolkitCatalog();
