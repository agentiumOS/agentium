import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS = "memory:decisions";

export interface Decision {
  id: string;
  decision: string;
  reasoning: string;
  decisionType: string;
  context?: string;
  alternatives?: string[];
  confidence?: number;
  importance?: number;
  outcome?: string;
  outcomeQuality?: "good" | "bad" | "neutral";
  agentName: string;
  sessionId?: string;
  createdAt: Date;
}

export class DecisionLog {
  private storage: StorageDriver;
  private maxContextDecisions: number;

  constructor(storage: StorageDriver, config?: { maxContextDecisions?: number }) {
    this.storage = storage;
    this.maxContextDecisions = config?.maxContextDecisions ?? 5;
  }

  async logDecision(agentName: string, decision: Omit<Decision, "id" | "agentName" | "createdAt">): Promise<Decision> {
    const entry: Decision = {
      ...decision,
      id: uuidv4(),
      agentName,
      createdAt: new Date(),
    };

    const key = `${agentName}:${entry.id}`;
    await this.storage.set(NS, key, entry);
    return entry;
  }

  async recordOutcome(
    agentName: string,
    decisionId: string,
    outcome: string,
    quality?: "good" | "bad" | "neutral",
  ): Promise<void> {
    const key = `${agentName}:${decisionId}`;
    const decision = await this.storage.get<Decision>(NS, key);
    if (!decision) return;

    decision.outcome = outcome;
    decision.outcomeQuality = quality;
    await this.storage.set(NS, key, decision);
  }

  async getDecisions(agentName: string, limit?: number): Promise<Decision[]> {
    const entries = await this.storage.list<Decision>(NS, agentName);
    const sorted = entries
      .map((e) => e.value)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return limit ? sorted.slice(0, limit) : sorted;
  }

  async searchDecisions(agentName: string, query: string): Promise<Decision[]> {
    const all = await this.getDecisions(agentName);
    const q = query.toLowerCase();
    return all.filter(
      (d) =>
        d.decision.toLowerCase().includes(q) ||
        d.reasoning.toLowerCase().includes(q) ||
        d.context?.toLowerCase().includes(q),
    );
  }

  async clear(agentName: string): Promise<void> {
    const entries = await this.storage.list<Decision>(NS, agentName);
    for (const entry of entries) {
      await this.storage.delete(NS, entry.key);
    }
  }

  async getContextString(agentName: string): Promise<string> {
    const decisions = await this.getDecisions(agentName, this.maxContextDecisions);
    if (decisions.length === 0) return "";

    const lines = decisions.map((d) => {
      let line = `- ${d.decision} (${d.decisionType})`;
      if (d.reasoning) line += ` — reason: ${d.reasoning}`;
      if (d.outcome) line += ` → outcome: ${d.outcome} (${d.outcomeQuality ?? "unknown"})`;
      return line;
    });

    return `Recent decisions:\n${lines.join("\n")}`;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "log_decision",
        description: "Log a decision with reasoning for future reference and learning.",
        parameters: z.object({
          decision: z.string().describe("What was decided"),
          reasoning: z.string().describe("Why this was chosen"),
          decisionType: z.string().describe("Type: tool_selection, approach, escalation, recommendation, other"),
          alternatives: z.array(z.string()).optional().describe("Other options considered"),
          confidence: z.number().optional().describe("Confidence level 0.0-1.0"),
        }),
        execute: async (args, ctx) => {
          const agentName = (ctx.metadata?.agentName as string) ?? "unknown";
          const entry = await this.logDecision(agentName, {
            decision: args.decision as string,
            reasoning: args.reasoning as string,
            decisionType: args.decisionType as string,
            alternatives: args.alternatives as string[] | undefined,
            confidence: args.confidence as number | undefined,
            sessionId: ctx.sessionId,
          });
          return `Decision logged: ${entry.id}`;
        },
      },
      {
        name: "record_outcome",
        description: "Record the outcome of a previously logged decision.",
        parameters: z.object({
          decisionId: z.string().describe("The decision ID to update"),
          outcome: z.string().describe("What happened"),
          quality: z.enum(["good", "bad", "neutral"]).optional().describe("Was the outcome good, bad, or neutral?"),
        }),
        execute: async (args, ctx) => {
          const agentName = (ctx.metadata?.agentName as string) ?? "unknown";
          await this.recordOutcome(
            agentName,
            args.decisionId as string,
            args.outcome as string,
            args.quality as "good" | "bad" | "neutral" | undefined,
          );
          return "Outcome recorded.";
        },
      },
      {
        name: "search_decisions",
        description: "Search past decisions by keyword.",
        parameters: z.object({
          query: z.string().describe("Search term"),
        }),
        execute: async (args, ctx) => {
          const agentName = (ctx.metadata?.agentName as string) ?? "unknown";
          const results = await this.searchDecisions(agentName, args.query as string);
          if (results.length === 0) return "No matching decisions found.";
          return results
            .slice(0, 10)
            .map((d) => `[${d.id}] ${d.decision} — ${d.reasoning}`)
            .join("\n");
        },
      },
    ];
  }

  async logToolCallAsDecision(agentName: string, toolName: string, args: unknown, sessionId?: string): Promise<void> {
    await this.logDecision(agentName, {
      decision: `Called tool "${toolName}"`,
      reasoning: `Tool invoked with args: ${JSON.stringify(args).slice(0, 200)}`,
      decisionType: "tool_selection",
      sessionId,
    });
  }
}
