import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS = "memory:procedures";

export interface ProcedureStep {
  toolName: string;
  argsSnapshot: Record<string, unknown>;
  resultSummary: string;
}

export interface Procedure {
  id: string;
  trigger: string;
  description: string;
  steps: ProcedureStep[];
  successCount: number;
  lastUsed: Date;
  createdAt: Date;
}

export interface ProcedureMemoryConfig {
  maxProcedures?: number;
  model?: ModelProvider;
}

const EXTRACTION_PROMPT = `You are a workflow extraction assistant. Analyze the conversation and identify any multi-step workflows (tool-call sequences) that were successfully completed.

For each workflow, extract:
- trigger: a short description of what task this workflow accomplishes
- description: a sentence explaining the steps
- steps: array of {toolName, argsSummary, resultSummary}

Only extract workflows with 2+ tool calls that completed successfully.
Return ONLY a JSON array: [{"trigger": "str", "description": "str", "steps": [{"toolName": "str", "argsSummary": "str", "resultSummary": "str"}]}]

If no workflows found, return [].

Conversation:
{conversation}`;

export class ProcedureMemory {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private maxProcedures: number;

  constructor(storage: StorageDriver, config?: ProcedureMemoryConfig) {
    this.storage = storage;
    this.model = config?.model;
    this.maxProcedures = config?.maxProcedures ?? 50;
  }

  async getProcedures(): Promise<Procedure[]> {
    const entries = await this.storage.list<Procedure>(NS);
    return entries.map((e) => e.value).sort((a, b) => b.successCount - a.successCount);
  }

  async getProcedure(id: string): Promise<Procedure | null> {
    return this.storage.get<Procedure>(NS, id);
  }

  async saveProcedure(proc: Omit<Procedure, "id" | "createdAt" | "successCount" | "lastUsed">): Promise<Procedure> {
    const existing = await this.getProcedures();
    const similar = existing.find((p) => p.trigger.toLowerCase() === proc.trigger.toLowerCase());

    if (similar) {
      similar.successCount++;
      similar.lastUsed = new Date();
      similar.steps = proc.steps;
      similar.description = proc.description;
      await this.storage.set(NS, similar.id, similar);
      return similar;
    }

    const entry: Procedure = {
      ...proc,
      id: uuidv4(),
      successCount: 1,
      lastUsed: new Date(),
      createdAt: new Date(),
    };

    await this.storage.set(NS, entry.id, entry);

    if (existing.length >= this.maxProcedures) {
      const sorted = existing.sort((a, b) => new Date(a.lastUsed).getTime() - new Date(b.lastUsed).getTime());
      const toRemove = sorted.slice(0, existing.length - this.maxProcedures + 1);
      for (const p of toRemove) {
        await this.storage.delete(NS, p.id);
      }
    }

    return entry;
  }

  async suggestProcedure(input: string): Promise<Procedure | null> {
    const all = await this.getProcedures();
    if (all.length === 0) return null;

    const inputLower = input.toLowerCase();
    let best: Procedure | null = null;
    let bestScore = 0;

    for (const proc of all) {
      let score = 0;
      const triggerLower = proc.trigger.toLowerCase();
      const descLower = proc.description.toLowerCase();

      if (inputLower.includes(triggerLower) || triggerLower.includes(inputLower)) score += 10;

      const words = inputLower.split(/\s+/);
      for (const word of words) {
        if (word.length < 3) continue;
        if (triggerLower.includes(word)) score += 3;
        if (descLower.includes(word)) score += 1;
      }

      score += Math.min(proc.successCount * 0.5, 5);

      if (score > bestScore) {
        bestScore = score;
        best = proc;
      }
    }

    return bestScore >= 3 ? best : null;
  }

  async getContextString(currentInput?: string): Promise<string> {
    if (!currentInput) return "";

    const suggestion = await this.suggestProcedure(currentInput);
    if (!suggestion) return "";

    const stepsStr = suggestion.steps
      .map((s, i) => `  ${i + 1}. ${s.toolName}(${JSON.stringify(s.argsSnapshot).slice(0, 80)}) → ${s.resultSummary}`)
      .join("\n");

    return `Suggested procedure (used ${suggestion.successCount}x): ${suggestion.trigger}\n${stepsStr}`;
  }

  async extractProcedures(messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const conversationStr = messages
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const prompt = EXTRACTION_PROMPT.replace("{conversation}", conversationStr);

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 800,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const jsonStr = extractJsonArray(text);
      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item?.trigger || !item?.steps || !Array.isArray(item.steps) || item.steps.length < 2) continue;

          await this.saveProcedure({
            trigger: item.trigger,
            description: item.description ?? item.trigger,
            steps: item.steps.map((s: any) => ({
              toolName: s.toolName ?? "unknown",
              argsSnapshot: typeof s.argsSummary === "string" ? { summary: s.argsSummary } : (s.argsSnapshot ?? {}),
              resultSummary: s.resultSummary ?? "",
            })),
          });
        }
      }
    } catch (err) {
      console.warn("[ProcedureMemory] extractProcedures failed:", (err as Error).message ?? err);
    }
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "recall_procedure",
        description:
          "Search for a known multi-step workflow that matches the current task. Returns the suggested sequence of tool calls.",
        parameters: z.object({
          task: z.string().describe("Description of the task to find a procedure for"),
        }),
        execute: async (args) => {
          const suggestion = await this.suggestProcedure(args.task as string);
          if (!suggestion) return "No matching procedure found. You may need to figure out the steps yourself.";
          const stepsStr = suggestion.steps.map((s, i) => `${i + 1}. ${s.toolName} → ${s.resultSummary}`).join("\n");
          return `Procedure: ${suggestion.trigger} (used ${suggestion.successCount}x)\n${stepsStr}`;
        },
      },
    ];
  }

  async clear(): Promise<void> {
    const all = await this.storage.list<Procedure>(NS);
    for (const entry of all) {
      await this.storage.delete(NS, entry.key);
    }
  }
}

function extractJsonArray(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const bracketStart = text.indexOf("[");
  const bracketEnd = text.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return text.slice(bracketStart, bracketEnd + 1);
  }

  return text.trim();
}
