/**
 * Every first-party toolkit, behind its own entry point.
 *
 * ```ts
 * import { GitHubToolkit, SlackToolkit } from "@agentium/core/toolkits";
 * ```
 *
 * Kept out of the main `@agentium/core` barrel so `import { Agent }` does not
 * pull 30 integrations into the bundle. Single toolkits can be imported
 * directly (`@agentium/core/toolkits/github`) to stay even smaller.
 */

export type { ToolkitConfigField, ToolkitMeta } from "./base.js";
export { collectToolkitTools, describeToolLibrary, Toolkit } from "./base.js";
export type { CalculatorConfig } from "./calculator.js";
export { CalculatorToolkit } from "./calculator.js";
export type { GoogleCalendarConfig } from "./calendar.js";
export { GoogleCalendarToolkit } from "./calendar.js";
export { ToolkitCatalog, toolkitCatalog } from "./catalog.js";
export type { CodeInterpreterConfig } from "./code-interpreter.js";
export { CodeInterpreterToolkit } from "./code-interpreter.js";
export type { DiscordConfig } from "./discord.js";
export { DiscordToolkit } from "./discord.js";
export type { DuckDuckGoConfig } from "./duckduckgo.js";
export { DuckDuckGoToolkit } from "./duckduckgo.js";
export type { FileSystemConfig } from "./filesystem.js";
export { FileSystemToolkit } from "./filesystem.js";
export type { GitConfig } from "./git.js";
export { GitToolkit } from "./git.js";
export type { GitHubConfig } from "./github.js";
export { GitHubToolkit } from "./github.js";
export type { GmailConfig } from "./gmail.js";
export { GmailToolkit } from "./gmail.js";
export type { GoogleSheetsConfig } from "./google-sheets.js";
export { GoogleSheetsToolkit } from "./google-sheets.js";
export type { GoogleWorkspaceConfig } from "./google-workspace.js";
export { GoogleWorkspaceToolkit } from "./google-workspace.js";
export type { HackerNewsConfig } from "./hackernews.js";
export { HackerNewsToolkit } from "./hackernews.js";
export type { HttpConfig } from "./http.js";
export { HttpToolkit } from "./http.js";
export type { ImageGenerationConfig } from "./image-generation.js";
export { ImageGenerationToolkit } from "./image-generation.js";
export type { JiraConfig } from "./jira.js";
export { JiraToolkit } from "./jira.js";
export type { NotionConfig } from "./notion.js";
export { NotionToolkit } from "./notion.js";
export type { PageIndexConfig } from "./pageindex.js";
export { PageIndexToolkit } from "./pageindex.js";
export type { PdfConfig } from "./pdf.js";
export { PdfToolkit } from "./pdf.js";
export type { RedisConfig } from "./redis.js";
export { RedisToolkit } from "./redis.js";
export type { S3Config } from "./s3.js";
export { S3Toolkit } from "./s3.js";
export { DaytonaSandbox, type DaytonaSandboxConfig, DaytonaSandboxToolkit } from "./sandbox-daytona.js";
export { E2BSandbox, type E2BSandboxConfig, E2BSandboxToolkit } from "./sandbox-e2b.js";
export type { ScraperConfig } from "./scraper.js";
export { ScraperToolkit } from "./scraper.js";
export type { ShellConfig } from "./shell.js";
export { ShellToolkit } from "./shell.js";
export type { SlackConfig } from "./slack.js";
export { SlackToolkit } from "./slack.js";
export type { SqlConfig } from "./sql.js";
export { SqlToolkit } from "./sql.js";
export type { StripeConfig } from "./stripe.js";
export { StripeToolkit } from "./stripe.js";
export type { TelegramConfig } from "./telegram.js";
export { TelegramToolkit } from "./telegram.js";
export type { WebSearchConfig } from "./websearch.js";
export { WebSearchToolkit } from "./websearch.js";
export type { WhatsAppConfig } from "./whatsapp.js";
export { WhatsAppToolkit } from "./whatsapp.js";
export type { WikipediaConfig } from "./wikipedia.js";
export { WikipediaToolkit } from "./wikipedia.js";
export type { YouTubeConfig } from "./youtube.js";
export { YouTubeToolkit } from "./youtube.js";
