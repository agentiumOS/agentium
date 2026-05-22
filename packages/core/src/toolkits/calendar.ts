import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface GoogleCalendarConfig {
  /** Path to OAuth2 credentials JSON file. Falls back to GOOGLE_CALENDAR_CREDENTIALS_PATH env var. */
  credentialsPath?: string;
  /** Path to saved token JSON file. Falls back to GOOGLE_CALENDAR_TOKEN_PATH env var. */
  tokenPath?: string;
  /** Pre-authenticated OAuth2 client (if you handle auth yourself). */
  authClient?: any;
  /** Calendar ID to operate on (default "primary"). */
  calendarId?: string;
}

/**
 * Google Calendar Toolkit — list, create, get, and delete calendar events.
 *
 * Requires: `npm install googleapis`
 *
 * Uses the same OAuth2 pattern as GmailToolkit.
 *
 * @example
 * ```ts
 * const cal = new GoogleCalendarToolkit({
 *   credentialsPath: "./credentials.json",
 *   tokenPath: "./token.json",
 * });
 * const agent = new Agent({ tools: [...cal.getTools()] });
 * ```
 */
export class GoogleCalendarToolkit extends Toolkit {
  readonly name = "calendar";
  private config: GoogleCalendarConfig;
  private calendarClient: any = null;

  constructor(config: GoogleCalendarConfig = {}) {
    super();
    this.config = config;
  }

  private get calendarId(): string {
    return this.config.calendarId ?? "primary";
  }

  private async getClient(): Promise<any> {
    if (this.calendarClient) return this.calendarClient;

    if (this.config.authClient) {
      const { google } = _require("googleapis");
      this.calendarClient = google.calendar({ version: "v3", auth: this.config.authClient });
      return this.calendarClient;
    }

    const credPath = this.config.credentialsPath ?? process.env.GOOGLE_CALENDAR_CREDENTIALS_PATH;
    const tokenPath = this.config.tokenPath ?? process.env.GOOGLE_CALENDAR_TOKEN_PATH;

    if (!credPath || !tokenPath) {
      throw new Error(
        "GoogleCalendarToolkit: Provide credentialsPath + tokenPath, or an authClient. " +
          "Set GOOGLE_CALENDAR_CREDENTIALS_PATH and GOOGLE_CALENDAR_TOKEN_PATH env vars.",
      );
    }

    const { google } = _require("googleapis");
    const fs = await import("node:fs");
    const creds = JSON.parse(fs.readFileSync(credPath, "utf-8"));
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));

    const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    oAuth2.setCredentials(token);

    this.calendarClient = google.calendar({ version: "v3", auth: oAuth2 });
    return this.calendarClient;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "calendar_list_events",
        description: "List upcoming events from Google Calendar.",
        parameters: z.object({
          maxResults: z.number().optional().describe("Max events to return (default 10)"),
          timeMin: z.string().optional().describe("Start time filter (ISO 8601). Defaults to now."),
          timeMax: z.string().optional().describe("End time filter (ISO 8601)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const cal = await this.getClient();
          const params: Record<string, unknown> = {
            calendarId: this.calendarId,
            maxResults: (args.maxResults as number) ?? 10,
            singleEvents: true,
            orderBy: "startTime",
            timeMin: (args.timeMin as string) ?? new Date().toISOString(),
          };
          if (args.timeMax) params.timeMax = args.timeMax;

          const res = await cal.events.list(params);
          const events = res.data.items ?? [];

          if (events.length === 0) return "No upcoming events.";

          return events
            .map((e: any, i: number) => {
              const start = e.start?.dateTime ?? e.start?.date ?? "";
              const end = e.end?.dateTime ?? e.end?.date ?? "";
              return `${i + 1}. ${e.summary ?? "(no title)"}\n   When: ${start} — ${end}\n   Location: ${e.location ?? "N/A"}\n   ID: ${e.id}`;
            })
            .join("\n\n");
        },
      },
      {
        name: "calendar_create_event",
        description: "Create a new event on Google Calendar.",
        parameters: z.object({
          summary: z.string().describe("Event title"),
          startTime: z.string().describe("Start time (ISO 8601, e.g. 2025-03-01T10:00:00-05:00)"),
          endTime: z.string().describe("End time (ISO 8601)"),
          description: z.string().optional().describe("Event description"),
          location: z.string().optional().describe("Event location"),
          attendees: z.array(z.string()).optional().describe("List of attendee email addresses"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const cal = await this.getClient();

          const event: Record<string, unknown> = {
            summary: args.summary,
            start: { dateTime: args.startTime },
            end: { dateTime: args.endTime },
          };

          if (args.description) event.description = args.description;
          if (args.location) event.location = args.location;
          if (args.attendees) {
            event.attendees = (args.attendees as string[]).map((email) => ({ email }));
          }

          const res = await cal.events.insert({
            calendarId: this.calendarId,
            requestBody: event,
          });

          return `Event created: ${res.data.summary}\nID: ${res.data.id}\nLink: ${res.data.htmlLink}`;
        },
      },
      {
        name: "calendar_get_event",
        description: "Get details of a specific Google Calendar event by ID.",
        parameters: z.object({
          eventId: z.string().describe("The event ID"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const cal = await this.getClient();

          const res = await cal.events.get({
            calendarId: this.calendarId,
            eventId: args.eventId,
          });

          const e = res.data;
          const start = e.start?.dateTime ?? e.start?.date ?? "";
          const end = e.end?.dateTime ?? e.end?.date ?? "";
          const attendees = (e.attendees ?? [])
            .map((a: any) => `${a.email} (${a.responseStatus ?? "unknown"})`)
            .join(", ");

          return [
            `Title: ${e.summary ?? "(no title)"}`,
            `When: ${start} — ${end}`,
            `Location: ${e.location ?? "N/A"}`,
            `Status: ${e.status}`,
            attendees ? `Attendees: ${attendees}` : null,
            e.description ? `\nDescription:\n${e.description}` : null,
            `Link: ${e.htmlLink}`,
          ]
            .filter((l) => l !== null)
            .join("\n");
        },
      },
      {
        name: "calendar_delete_event",
        description: "Delete an event from Google Calendar by ID.",
        parameters: z.object({
          eventId: z.string().describe("The event ID to delete"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const cal = await this.getClient();

          await cal.events.delete({
            calendarId: this.calendarId,
            eventId: args.eventId,
          });

          return `Event ${args.eventId} deleted successfully.`;
        },
      },
    ];
  }
}
