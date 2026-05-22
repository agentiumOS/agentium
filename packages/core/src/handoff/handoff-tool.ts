import { z } from "zod";
import type { RunContext } from "../agent/run-context.js";
import type { ToolDef } from "../tools/types.js";
import { HandoffSignal, type HandoffTarget } from "./types.js";

export function createHandoffTool(targets: HandoffTarget[]): ToolDef {
  const agentNames = targets.map((t) => t.agent.name);
  const descriptions = targets.map((t) => `- ${t.agent.name}: ${t.description}`).join("\n");

  return {
    name: "transfer_to_agent",
    description: `Transfer the conversation to a specialist agent. Available agents:\n${descriptions}`,
    parameters: z.object({
      agent: z.enum(agentNames as [string, ...string[]]).describe("Name of the agent to transfer to"),
      reason: z.string().describe("Brief reason for the handoff"),
    }),
    execute: async (args: Record<string, unknown>, _ctx: RunContext): Promise<string> => {
      throw new HandoffSignal(args.agent as string, args.reason as string);
    },
  };
}

export function createCompleteTool(): ToolDef {
  return {
    name: "complete",
    description: "Signal that you have fully handled the user's request and no further handoff is needed.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what was accomplished"),
    }),
    execute: async (args: Record<string, unknown>): Promise<string> => {
      return `Completed: ${args.summary}`;
    },
  };
}
