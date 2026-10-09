import { defineTool } from "@agentium/core";
import { z } from "zod/v3";

/** Grant this tool explicitly to let the model ask a voluntary, live question. */
export function requestInputTool(options: { name?: string; description?: string; timeoutMs?: number } = {}) {
  return defineTool({
    name: options.name ?? "request_input",
    description: options.description ?? "Ask the user a question and wait for their answer before continuing.",
    parameters: z.object({
      question: z.string().min(1),
      choices: z.array(z.string().min(1)).optional(),
    }),
    execute: async (input, ctx) => {
      if (!ctx.executionServices?.requestInput) throw new Error("request_input requires live input execution services");
      const reply = await ctx.executionServices.requestInput({ ...input, timeoutMs: options.timeoutMs });
      return JSON.stringify(reply);
    },
  });
}
