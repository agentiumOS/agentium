import { createRequire } from "node:module";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

const _require = createRequire(import.meta.url);

export interface GoogleSheetsConfig {
  /** Path to Google OAuth2 credentials JSON file. Falls back to GOOGLE_SHEETS_CREDENTIALS_PATH env var. */
  credentialsPath?: string;
  /** Path to stored OAuth2 token. Falls back to GOOGLE_SHEETS_TOKEN_PATH env var. */
  tokenPath?: string;
  /** Spreadsheet ID (from the URL). Falls back to GOOGLE_SHEETS_SPREADSHEET_ID env var. */
  spreadsheetId?: string;
}

/**
 * Google Sheets Toolkit — read, write, and append data in Google Sheets.
 *
 * Requires the `googleapis` peer dependency and Google OAuth2 credentials.
 *
 * @example
 * ```ts
 * const sheets = new GoogleSheetsToolkit({
 *   credentialsPath: "./credentials.json",
 *   tokenPath: "./token.json",
 *   spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
 * });
 * const agent = new Agent({ tools: [...sheets.getTools()] });
 * ```
 */
export class GoogleSheetsToolkit extends Toolkit {
  readonly name = "google_sheets";
  private credentialsPath: string;
  private tokenPath: string;
  private defaultSpreadsheetId: string;
  private sheetsClient: any;

  constructor(config: GoogleSheetsConfig = {}) {
    super();
    this.credentialsPath = config.credentialsPath ?? process.env.GOOGLE_SHEETS_CREDENTIALS_PATH ?? "";
    this.tokenPath = config.tokenPath ?? process.env.GOOGLE_SHEETS_TOKEN_PATH ?? "";
    this.defaultSpreadsheetId = config.spreadsheetId ?? process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "";
  }

  private async getClient(): Promise<any> {
    if (this.sheetsClient) return this.sheetsClient;

    const { google } = _require("googleapis");
    const fs = await import("node:fs");

    const creds = JSON.parse(fs.readFileSync(this.credentialsPath, "utf-8"));
    const token = JSON.parse(fs.readFileSync(this.tokenPath, "utf-8"));

    const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    oAuth2.setCredentials(token);

    this.sheetsClient = google.sheets({ version: "v4", auth: oAuth2 });
    return this.sheetsClient;
  }

  private resolveSpreadsheetId(args: Record<string, unknown>): string {
    return (
      (args.spreadsheetId as string) ||
      this.defaultSpreadsheetId ||
      (() => {
        throw new Error("spreadsheetId is required");
      })()
    );
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "sheets_read_range",
        description: "Read data from a range in a Google Sheet.",
        parameters: z.object({
          range: z.string().describe("A1 notation range (e.g. 'Sheet1!A1:D10')"),
          spreadsheetId: z.string().optional().describe("Spreadsheet ID (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const sheets = await this.getClient();
            const res = await sheets.spreadsheets.values.get({
              spreadsheetId: this.resolveSpreadsheetId(args),
              range: args.range,
            });
            const rows = res.data.values ?? [];
            if (rows.length === 0) return "(empty range)";
            return rows.map((row: string[]) => row.join("\t")).join("\n");
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sheets_write_range",
        description: "Write data to a range in a Google Sheet (overwrites existing data).",
        parameters: z.object({
          range: z.string().describe("A1 notation range (e.g. 'Sheet1!A1')"),
          values: z.array(z.array(z.string())).describe("2D array of values to write"),
          spreadsheetId: z.string().optional().describe("Spreadsheet ID (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const sheets = await this.getClient();
            const res = await sheets.spreadsheets.values.update({
              spreadsheetId: this.resolveSpreadsheetId(args),
              range: args.range,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: args.values },
            });
            return JSON.stringify({
              updatedRange: res.data.updatedRange,
              updatedRows: res.data.updatedRows,
              updatedColumns: res.data.updatedColumns,
              updatedCells: res.data.updatedCells,
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sheets_append_row",
        description: "Append a row to the end of a sheet.",
        parameters: z.object({
          range: z.string().describe("Sheet name or range (e.g. 'Sheet1')"),
          values: z.array(z.string()).describe("Row values to append"),
          spreadsheetId: z.string().optional().describe("Spreadsheet ID (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const sheets = await this.getClient();
            const res = await sheets.spreadsheets.values.append({
              spreadsheetId: this.resolveSpreadsheetId(args),
              range: args.range,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [args.values] },
            });
            return JSON.stringify({
              updatedRange: res.data.updates?.updatedRange,
              updatedRows: res.data.updates?.updatedRows,
            });
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
      {
        name: "sheets_list_sheets",
        description: "List all sheets (tabs) in a spreadsheet.",
        parameters: z.object({
          spreadsheetId: z.string().optional().describe("Spreadsheet ID (uses default if omitted)"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          try {
            const sheets = await this.getClient();
            const res = await sheets.spreadsheets.get({
              spreadsheetId: this.resolveSpreadsheetId(args),
              fields: "sheets.properties",
            });
            const sheetList = (res.data.sheets ?? []).map((s: any) => ({
              id: s.properties.sheetId,
              title: s.properties.title,
              index: s.properties.index,
              rowCount: s.properties.gridProperties?.rowCount,
              columnCount: s.properties.gridProperties?.columnCount,
            }));
            return JSON.stringify(sheetList, null, 2);
          } catch (err: any) {
            return JSON.stringify({ error: err.message });
          }
        },
      },
    ];
  }
}
