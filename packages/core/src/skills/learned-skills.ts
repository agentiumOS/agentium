import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { StorageDriver } from "../storage/driver.js";
import type { ToolCallResult, ToolDef } from "../tools/types.js";

const NS = "skills:learned";

export interface LearnedSkillStep {
  toolName: string;
  args: Record<string, unknown>;
  expectedResult?: string;
}

export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  steps: LearnedSkillStep[];
  successCount: number;
  failCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class LearnedSkillStore {
  private storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.storage = storage;
  }

  async saveSkill(
    skill: Omit<LearnedSkill, "id" | "createdAt" | "updatedAt" | "successCount" | "failCount">,
  ): Promise<LearnedSkill> {
    const entry: LearnedSkill = {
      ...skill,
      id: uuidv4(),
      successCount: 0,
      failCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.set(NS, entry.id, entry);
    return entry;
  }

  async getSkill(id: string): Promise<LearnedSkill | null> {
    return this.storage.get<LearnedSkill>(NS, id);
  }

  async listSkills(): Promise<LearnedSkill[]> {
    const entries = await this.storage.list<LearnedSkill>(NS);
    return entries.map((e) => e.value);
  }

  async searchSkills(query: string): Promise<LearnedSkill[]> {
    const all = await this.listSkills();
    const q = query.toLowerCase();
    return all.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }

  async recordOutcome(skillId: string, success: boolean): Promise<void> {
    const skill = await this.getSkill(skillId);
    if (!skill) return;

    if (success) {
      skill.successCount++;
    } else {
      skill.failCount++;
    }
    skill.updatedAt = new Date();
    await this.storage.set(NS, skillId, skill);
  }

  async deleteSkill(id: string): Promise<void> {
    await this.storage.delete(NS, id);
  }

  /**
   * Replay a learned skill by executing its steps sequentially.
   * Returns the results of each step.
   */
  async replaySkill(
    skillId: string,
    ctx: RunContext,
    executeToolFn: (toolName: string, args: Record<string, unknown>, ctx: RunContext) => Promise<ToolCallResult>,
  ): Promise<ToolCallResult[]> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error(`Learned skill "${skillId}" not found`);

    const results: ToolCallResult[] = [];
    for (const step of skill.steps) {
      try {
        const result = await executeToolFn(step.toolName, step.args, ctx);
        results.push(result);
      } catch (e: any) {
        results.push({
          toolCallId: uuidv4(),
          toolName: step.toolName,
          result: `Error: ${e.message}`,
          error: e.message,
        });
        await this.recordOutcome(skillId, false);
        return results;
      }
    }

    await this.recordOutcome(skillId, true);
    return results;
  }

  getTools(): ToolDef[] {
    return [
      {
        name: "save_skill",
        description: "Save a successful multi-step workflow as a reusable skill for future replay.",
        parameters: z.object({
          name: z.string().describe("Short name for the skill"),
          description: z.string().describe("What this skill does"),
          steps: z
            .array(
              z.object({
                toolName: z.string().describe("Tool to call"),
                args: z.record(z.unknown()).describe("Arguments to pass"),
              }),
            )
            .describe("Ordered list of tool calls"),
        }),
        execute: async (args) => {
          const skill = await this.saveSkill({
            name: args.name as string,
            description: args.description as string,
            steps: args.steps as LearnedSkillStep[],
          });
          return `Skill saved: "${skill.name}" (${skill.id}) with ${skill.steps.length} steps.`;
        },
      },
      {
        name: "search_skills",
        description: "Search previously saved learned skills by keyword.",
        parameters: z.object({
          query: z.string().describe("Search term"),
        }),
        execute: async (args) => {
          const results = await this.searchSkills(args.query as string);
          if (results.length === 0) return "No matching skills found.";
          return results
            .map((s) => `[${s.id}] ${s.name}: ${s.description} (success: ${s.successCount}, fail: ${s.failCount})`)
            .join("\n");
        },
      },
    ];
  }
}
