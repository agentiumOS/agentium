import { resolve } from "node:path";
import {
  Agent,
  type AgentConfig,
  type ChatMessage,
  type RunOpts,
  type RunOutput,
  type Team,
  type Workflow,
} from "@agentium/core";
import type {
  ExecutionDriver,
  HarnessDriverOutput,
  HarnessExecutionServices,
  HarnessRunRequest,
} from "./runtime/index.js";

const capabilities = Object.freeze({
  controls: ["follow_up"] as const,
  durable: false,
  policyCoverage: "local" as const,
  controlledExecution: true,
});
function options(request: HarnessRunRequest, services: HarnessExecutionServices): RunOpts {
  return {
    sessionId: services.sessionKey,
    runId: request.runId,
    userId: request.identity.userId,
    tenantId: request.identity.tenantId,
    signal: request.signal,
    runMode: request.runMode,
    history: services.history,
    executionServices: services,
    metadata: { parentRunId: request.parentRunId, rootRunId: request.rootRunId, attemptId: request.attemptId },
  };
}
function output(result: RunOutput, history?: readonly ChatMessage[]): HarnessDriverOutput {
  return {
    text:
      [...(result.publicMessages ?? [])].reverse().find((message) => message.phase === "final")?.text ?? result.text,
    structured: result.structured,
    usage: result.usage,
    status: result.status === "error" ? "failed" : (result.status ?? "completed"),
    ...(history ? { history } : {}),
  };
}
function emitText(services: HarnessExecutionServices, text: string): void {
  // Provider chunks and nonstreaming results may exceed the generic event limit.
  for (let offset = 0; offset < text.length; offset += 8192)
    services.emit({ type: "text.delta", text: text.slice(offset, offset + 8192) });
}
/** Passing an Agent borrows it. Passing configuration creates/disposes a run-owned
 * Agent and applies the definition's explicit defaults here, outside core. */
export function agentDriver(agent: Agent | AgentConfig, config: { stream?: boolean } = {}): ExecutionDriver {
  return {
    id: `agent:${agent.name}`,
    version: 1,
    capabilities: { ...capabilities, controls: ["follow_up", "steer"] },
    async start(request, services) {
      const owned = !(agent instanceof Agent);
      if (
        !owned &&
        services.agentConfiguration &&
        (Object.keys(services.agentConfiguration.defaults).length ||
          Object.keys(services.agentConfiguration.limits).length)
      )
        throw new Error("Harness Agent defaults require agentDriver(config); a borrowed Agent is already configured");
      const instance = owned
        ? await services.resource(`agentium:driver:${agent.name}`, "run", async () => {
            const value = new Agent(configureAgent(agent as AgentConfig, services));
            return { value, ownership: "runtime", dispose: () => value.close({ closeStorage: false }) };
          })
        : (agent as Agent);
      {
        if (!config.stream) {
          const result = await instance.run(request.input, options(request, services));
          emitText(services, result.text);
          return output(result, services.history);
        }
        let result: RunOutput | undefined;
        const listener = (event: { runId: string; output: RunOutput }) => {
          if (event.runId === request.runId) result = event.output;
        };
        instance.eventBus.on("run.complete", listener);
        try {
          for await (const chunk of instance.stream(request.input, options(request, services)))
            if (chunk.type === "text") emitText(services, chunk.text);
        } finally {
          instance.eventBus.off("run.complete", listener);
        }
        if (!result) throw new Error("Agent stream ended without a completed lifecycle result");
        return output(result, services.history);
      }
    },
  };
}
/** Input defaults to a JSON object patch over the Workflow constructor's initial state. */
export function workflowDriver<T extends Record<string, unknown>>(
  workflow: Workflow<T>,
  config: { input?: (input: HarnessRunRequest["input"]) => Partial<T> } = {},
): ExecutionDriver {
  return {
    id: `workflow:${workflow.name}`,
    version: 1,
    capabilities,
    async start(request, services) {
      const patch = config.input
        ? config.input(request.input)
        : JSON.parse(typeof request.input === "string" ? request.input : "null");
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Workflow driver input must be a JSON object");
      const result = await workflow.run({ ...options(request, services), initialState: patch });
      const failed = result.stepResults.find((step) => step.status === "error");
      const text = JSON.stringify(result.state);
      services.append([
        { role: "user", content: request.input },
        { role: "assistant", content: text },
      ]);
      return {
        text,
        structured: result.state,
        status: failed ? "failed" : "completed",
        ...(failed ? { reason: { code: "workflow_step_failed", message: failed.error ?? failed.stepName } } : {}),
      };
    },
  };
}
/** Remote Team members fail explicitly because their effects cannot be intercepted locally. */
export function teamDriver(team: Team): ExecutionDriver {
  return {
    id: `team:${team.name}`,
    version: 1,
    capabilities,
    async start(request, services) {
      if (typeof request.input !== "string") throw new Error("Team driver requires text input");
      const result = await team.run(request.input, options(request, services));
      services.append([
        { role: "user", content: request.input },
        { role: "assistant", content: result.text },
      ]);
      return output(result);
    },
  };
}

function configureAgent(input: AgentConfig, services: HarnessExecutionServices): AgentConfig {
  const settings = services.agentConfiguration;
  const explicit = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  const merged = { ...settings?.defaults, ...explicit, register: false } as AgentConfig;
  const root = settings?.projectRoot ?? process.cwd();
  if (merged.workspace) merged.workspace = { ...merged.workspace, path: resolve(root, merged.workspace.path) };
  if (merged.skillDirs) merged.skillDirs = merged.skillDirs.map((path) => resolve(root, path));
  if (merged.contextFiles === true) merged.contextFiles = { cwd: root };
  else if (merged.contextFiles)
    merged.contextFiles = { ...merged.contextFiles, cwd: resolve(root, merged.contextFiles.cwd ?? ".") };
  const cap = settings?.limits.toolRoundtrips;
  if (cap !== undefined) merged.maxToolRoundtrips = Math.min(merged.maxToolRoundtrips ?? 10, cap);
  if (merged.subagents) {
    const maxDepth = typeof merged.subagents === "object" ? (merged.subagents.maxDepth ?? 2) : 2;
    merged.subagents = { maxDepth: Math.min(maxDepth, settings?.limits.maxChildDepth ?? Infinity) };
  }
  return merged;
}
