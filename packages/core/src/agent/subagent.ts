import { randomUUID as uuidv4 } from "node:crypto";
import { z } from "zod/v3";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";
import type { Agent } from "./agent.js";
import type { RunOpts } from "./types.js";

export interface SubagentSpec {
  name?: string;
  instructions?: string;
  tools?: ToolDef[];
  maxToolRoundtrips?: number;
}

export interface SpawnSubagentOptions {
  parent: Agent;
  task: string;
  spec?: SubagentSpec;
  runOpts?: RunOpts;
  depth?: number;
  maxDepth?: number;
  /** Actual parent run identity, when delegation originates from a tool call. */
  parentRunId?: string;
}

/**
 * Run a child agent with a fresh message list.
 * The parent only sees the child's final text — not its tool chatter.
 */
export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<string> {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 2;
  if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("Subagent depth limits must be nonnegative integers");
  }
  if (depth >= maxDepth) {
    return `Subagent depth limit (${maxDepth}) reached. Handle the task yourself.`;
  }

  const { Agent } = await import("./agent.js");
  const parent = opts.parent;
  const name = opts.spec?.name ?? `${parent.name}-sub`;
  const child = new Agent(parent.getSubagentConfig(opts.spec));

  try {
    parent.eventBus.emit("subagent.start", {
      runId: "pending",
      parentRunId: opts.parentRunId ?? "",
      agentName: name,
      task: opts.task,
    });
    const output = await child.run(opts.task, {
      ...opts.runOpts,
      sessionId: `${opts.runOpts?.sessionId ?? "run"}:${name}:${uuidv4()}`,
    });
    parent.eventBus.emit("subagent.complete", {
      runId: output.runId ?? name,
      parentRunId: opts.parentRunId ?? "",
      agentName: name,
      text: output.text,
    });
    return output.text;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    parent.eventBus.emit("subagent.error", {
      runId: name,
      parentRunId: opts.parentRunId ?? "",
      agentName: name,
      error,
    });
    return `Subagent failed: ${error.message}`;
  } finally {
    await child.close();
  }
}

export function createTaskTool(parent: Agent, config?: { maxDepth?: number }): ToolDef {
  return defineTool({
    name: "task",
    description:
      "Delegate a focused subtask to an isolated subagent. The child has its own context and returns one final report.",
    parameters: z.object({
      task: z.string().describe("What the subagent should do"),
      instructions: z.string().optional().describe("Optional specialist instructions"),
    }),
    execute: async ({ task, instructions }, ctx) => {
      return spawnSubagent({
        parent,
        task,
        spec: { instructions },
        runOpts: {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          signal: ctx.signal,
          executionServices: ctx.executionServices,
          runMode: ctx.runMode,
          dependencies: ctx.dependencies,
          metadata: { ...ctx.metadata, parentRunId: ctx.runId },
          questions: ctx.questions,
        },
        parentRunId: ctx.runId,
        maxDepth: config?.maxDepth,
      });
    },
  });
}
