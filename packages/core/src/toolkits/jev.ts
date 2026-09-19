import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import { choice, createTypeSafeClient, noul, questionsFromSpecs, score } from "../models/jev-sdk.js";
import type { ToolDef } from "../tools/types.js";
import { Toolkit } from "./base.js";

export interface JevToolkitConfig {
  /** TypeSafe API key. Falls back to `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** TypeSafe API root. */
  baseURL?: string;
  /** Jev model id. Default: `jev-latest`. */
  model?: string;
  /**
   * Named question packs for `jev_evaluate`.
   * Each pack is a record of TypeSafe questions (`choice` / `noul` / `score`)
   * or JSON specs `{ type, question, options | levels }`.
   */
  packs?: Record<string, Record<string, unknown>>;
}

function parseState(raw: unknown): unknown {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function parseQuestionsJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  throw new Error("jev_ask questions must be a JSON object of named questions.");
}

/**
 * Jev Toolkit — TypeSafe System One judgments as tools on a chat agent.
 *
 * @example
 * ```ts
 * const jevTk = new JevToolkit();
 * const agent = new Agent({ model: anthropic("claude-sonnet-4-6"), tools: [...jevTk.getTools()] });
 * ```
 */
export class JevToolkit extends Toolkit {
  readonly name = "jev";
  private config: JevToolkitConfig;
  /** Tests assign a mock client here. */
  client: any;

  constructor(config: JevToolkitConfig = {}) {
    super();
    this.config = config;
  }

  private getClient(): any {
    if (this.client) return this.client;
    this.client = createTypeSafeClient({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      defaultModel: this.config.model ?? "jev-latest",
    });
    return this.client;
  }

  private async ask(questions: Record<string, unknown>, state: unknown): Promise<string> {
    const result = await this.getClient().systemOne({
      state,
      questions,
      model: this.config.model ?? "jev-latest",
    });
    return JSON.stringify(result?.answers ?? result, null, 2);
  }

  getTools(): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: "jev_choose",
        description:
          "Ask Jev to pick one option from a closed list. Returns choice, probabilities, and confidence. Use for routing, classification, and labels.",
        parameters: z.object({
          question: z.string().describe("What to decide"),
          options: z.array(z.string()).min(2).describe("The allowed labels. Jev will pick exactly one."),
          state: z.string().describe("Text or JSON to evaluate against"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const criteria: Record<string, unknown> = {};
          for (const opt of args.options as string[]) criteria[opt] = null;
          return this.ask({ choice: choice(args.question, criteria) }, parseState(args.state));
        },
      },
      {
        name: "jev_score",
        description: "Ask Jev to score the state on an ordered rubric. Returns score, probabilities, and confidence.",
        parameters: z.object({
          question: z.string().describe("What to rate"),
          levels: z.array(z.string()).min(2).describe("Ordered rubric labels from lowest (index 0) to highest"),
          state: z.string().describe("Text or JSON to evaluate against"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          return this.ask({ score: score(args.question, args.levels as string[]) }, parseState(args.state));
        },
      },
      {
        name: "jev_noul",
        description: "Ask Jev whether a statement is true. Returns noul (0–1 probability of yes).",
        parameters: z.object({
          statement: z.string().describe("Yes/no statement to evaluate"),
          state: z.string().describe("Text or JSON to evaluate against"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          return this.ask({ noul: noul(args.statement) }, parseState(args.state));
        },
      },
      {
        name: "jev_ask",
        description:
          "Ask several Jev questions in one call against the same state. questions is a JSON object of { type: choice|score|noul, question, options|levels }.",
        parameters: z.object({
          questions: z
            .string()
            .describe(
              'JSON object, e.g. {"urgent":{"type":"noul","question":"Is this urgent?"},"team":{"type":"choice","question":"Which team?","options":["billing","tech"]}}',
            ),
          state: z.string().describe("Text or JSON to evaluate against"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const specs = parseQuestionsJson(args.questions);
          return this.ask(questionsFromSpecs(specs), parseState(args.state));
        },
      },
    ];

    if (this.config.packs && Object.keys(this.config.packs).length > 0) {
      const packNames = Object.keys(this.config.packs);
      tools.push({
        name: "jev_evaluate",
        description: `Run a named Jev question pack. Packs: ${packNames.join(", ")}.`,
        parameters: z.object({
          pack: z.string().describe(`Pack name. One of: ${packNames.join(", ")}`),
          state: z.string().describe("Text or JSON to evaluate against"),
        }),
        execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
          const name = args.pack as string;
          const pack = this.config.packs?.[name];
          if (!pack) {
            return `Unknown pack "${name}". Available: ${packNames.join(", ")}`;
          }
          const first = Object.values(pack)[0] as Record<string, unknown> | undefined;
          const looksLikeSpec =
            first && typeof first === "object" && ("type" in first || "options" in first || "levels" in first);
          const questions = looksLikeSpec ? questionsFromSpecs(pack) : pack;
          return this.ask(questions, parseState(args.state));
        },
      });
    }

    return tools;
  }
}
