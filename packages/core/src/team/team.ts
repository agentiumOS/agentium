import { v4 as uuidv4 } from "uuid";
import type { A2ARemoteAgent } from "../a2a/a2a-remote-agent.js";
import type { Agent } from "../agent/agent.js";
import { RunContext } from "../agent/run-context.js";
import type { RunOpts, RunOutput } from "../agent/types.js";
import { EventBus } from "../events/event-bus.js";
import { HandoffSignal } from "../handoff/types.js";
import { getTextContent, type StreamChunk, type TokenUsage } from "../models/types.js";
import { registry } from "../serve.js";
import { type TeamConfig, TeamMode } from "./types.js";

interface DelegationPlan {
  memberId: string;
  task: string;
}

export class Team {
  readonly kind = "team" as const;
  readonly name: string;
  readonly eventBus: EventBus;

  private config: TeamConfig;

  constructor(config: TeamConfig) {
    this.config = config;
    this.name = config.name;
    this.eventBus = config.eventBus ?? new EventBus();

    if (config.register !== false) {
      registry.add(this);
    }
  }

  async run(input: string, opts?: RunOpts): Promise<RunOutput> {
    const ctx = new RunContext({
      sessionId: opts?.sessionId ?? uuidv4(),
      userId: opts?.userId,
      metadata: opts?.metadata ?? {},
      eventBus: this.eventBus,
      sessionState: { ...(this.config.sessionState ?? {}) },
    });

    this.eventBus.emit("run.start", {
      runId: ctx.runId,
      agentName: this.name,
      input,
    });

    try {
      let output: RunOutput;

      switch (this.config.mode) {
        case TeamMode.Route:
          output = await this.runRouteMode(input, ctx);
          break;
        case TeamMode.Broadcast:
          output = await this.runBroadcastMode(input, ctx);
          break;
        case TeamMode.Collaborate:
          output = await this.runCollaborateMode(input, ctx);
          break;
        case TeamMode.Handoff:
          output = await this.runHandoffMode(input, ctx);
          break;
        default:
          output = await this.runCoordinateMode(input, ctx);
          break;
      }

      this.eventBus.emit("run.complete", { runId: ctx.runId, output });
      return output;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.eventBus.emit("run.error", { runId: ctx.runId, error: err });
      throw err;
    }
  }

  async *stream(input: string, opts?: RunOpts): AsyncGenerator<StreamChunk> {
    const result = await this.run(input, opts);
    yield { type: "text", text: result.text };
    yield { type: "finish", finishReason: "stop", usage: result.usage };
  }

  private async runCoordinateMode(input: string, ctx: RunContext): Promise<RunOutput> {
    const memberDescriptions = this.buildMemberDescriptions();
    const planPrompt = this.buildCoordinatorPrompt(input, memberDescriptions, "coordinate");

    const planResponse = await this.config.model.generate([
      { role: "system", content: planPrompt },
      { role: "user", content: input },
    ]);

    const delegations = this.parseDelegationPlan(getTextContent(planResponse.message.content));

    const memberOutputs: Array<{ memberId: string; output: RunOutput }> = [];

    for (const delegation of delegations) {
      const member = this.findMember(delegation.memberId);
      if (!member) continue;

      this.eventBus.emit("team.delegate", {
        runId: ctx.runId,
        memberId: delegation.memberId,
        task: delegation.task,
      });

      const output = await member.run(delegation.task, {
        sessionId: ctx.sessionId,
      });
      memberOutputs.push({ memberId: delegation.memberId, output });
    }

    const synthesisPrompt = this.buildSynthesisPrompt(input, memberOutputs);
    const synthesisResponse = await this.config.model.generate([{ role: "user", content: synthesisPrompt }]);

    return {
      text: getTextContent(synthesisResponse.message.content),
      toolCalls: memberOutputs.flatMap((o) => o.output.toolCalls),
      usage: synthesisResponse.usage,
    };
  }

  private async runRouteMode(input: string, ctx: RunContext): Promise<RunOutput> {
    const memberDescriptions = this.buildMemberDescriptions();
    const routePrompt = this.buildCoordinatorPrompt(input, memberDescriptions, "route");

    const routeResponse = await this.config.model.generate([
      { role: "system", content: routePrompt },
      { role: "user", content: input },
    ]);

    const selectedName = getTextContent(routeResponse.message.content).trim();
    const member = this.findMember(selectedName);

    if (!member) {
      return {
        text: `Could not route to member "${selectedName}". Available: ${this.config.members.map((m) => m.name).join(", ")}`,
        toolCalls: [],
        usage: routeResponse.usage,
      };
    }

    this.eventBus.emit("team.delegate", {
      runId: ctx.runId,
      memberId: member.name,
      task: input,
    });

    return member.run(input, { sessionId: ctx.sessionId });
  }

  private async runBroadcastMode(input: string, ctx: RunContext): Promise<RunOutput> {
    for (const member of this.config.members) {
      this.eventBus.emit("team.delegate", {
        runId: ctx.runId,
        memberId: member.name,
        task: input,
      });
    }

    const outputs = await Promise.all(
      this.config.members.map((member) => member.run(input, { sessionId: ctx.sessionId })),
    );

    const memberOutputs = this.config.members.map((member, i) => ({
      memberId: member.name,
      output: outputs[i],
    }));

    const synthesisPrompt = this.buildSynthesisPrompt(input, memberOutputs);
    const synthesisResponse = await this.config.model.generate([{ role: "user", content: synthesisPrompt }]);

    return {
      text: getTextContent(synthesisResponse.message.content),
      toolCalls: outputs.flatMap((o) => o.toolCalls),
      usage: synthesisResponse.usage,
    };
  }

  private async runCollaborateMode(input: string, ctx: RunContext): Promise<RunOutput> {
    const maxRounds = this.config.maxRounds ?? 3;
    let currentInput = input;
    let finalOutput: RunOutput | null = null;

    for (let round = 0; round < maxRounds; round++) {
      for (const member of this.config.members) {
        this.eventBus.emit("team.delegate", {
          runId: ctx.runId,
          memberId: member.name,
          task: currentInput,
        });
      }

      const outputs = await Promise.all(
        this.config.members.map((member) => member.run(currentInput, { sessionId: ctx.sessionId })),
      );

      const memberOutputs = this.config.members.map((member, i) => ({
        memberId: member.name,
        output: outputs[i],
      }));

      const consensusPrompt = `Given the following responses to "${input}", determine if there is consensus. If yes, synthesize a final answer. If not, provide a follow-up question.\n\n${memberOutputs.map((o) => `${o.memberId}: ${o.output.text}`).join("\n\n")}\n\nRespond with either "CONSENSUS: <final answer>" or "FOLLOW_UP: <question>"`;

      const consensusResponse = await this.config.model.generate([{ role: "user", content: consensusPrompt }]);

      const responseText = getTextContent(consensusResponse.message.content);

      if (responseText.startsWith("CONSENSUS:")) {
        finalOutput = {
          text: responseText.slice("CONSENSUS:".length).trim(),
          toolCalls: outputs.flatMap((o) => o.toolCalls),
          usage: consensusResponse.usage,
        };
        break;
      }

      currentInput = responseText.startsWith("FOLLOW_UP:")
        ? responseText.slice("FOLLOW_UP:".length).trim()
        : responseText;
    }

    if (!finalOutput) {
      const lastSynthesis = this.buildSynthesisPrompt(input, []);
      const response = await this.config.model.generate([{ role: "user", content: lastSynthesis }]);
      finalOutput = {
        text: getTextContent(response.message.content),
        toolCalls: [],
        usage: response.usage,
      };
    }

    return finalOutput!;
  }

  private async runHandoffMode(input: string, ctx: RunContext): Promise<RunOutput> {
    const maxHandoffs = this.config.maxRounds ?? 5;
    const chain: string[] = [];
    let currentAgent = this.config.members[0];
    let currentInput = input;
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastOutput: RunOutput | null = null;

    for (let hop = 0; hop <= maxHandoffs; hop++) {
      chain.push(currentAgent.name);

      this.eventBus.emit("team.delegate", {
        runId: ctx.runId,
        memberId: currentAgent.name,
        task: currentInput,
      });

      try {
        const output = await currentAgent.run(currentInput, { sessionId: ctx.sessionId });

        totalUsage = {
          promptTokens: totalUsage.promptTokens + output.usage.promptTokens,
          completionTokens: totalUsage.completionTokens + output.usage.completionTokens,
          totalTokens: totalUsage.totalTokens + output.usage.totalTokens,
        };
        lastOutput = output;
        break;
      } catch (err) {
        if (err instanceof HandoffSignal) {
          const nextAgent = this.findMember(err.targetAgent);
          if (!nextAgent) {
            throw new Error(
              `Handoff target "${err.targetAgent}" not found in team. Available: ${this.config.members.map((m) => m.name).join(", ")}`,
            );
          }

          this.eventBus.emit("handoff.transfer" as any, {
            runId: ctx.runId,
            fromAgent: currentAgent.name,
            toAgent: nextAgent.name,
            reason: err.reason,
          });

          currentAgent = nextAgent;
          currentInput = `[Handed off from ${chain[chain.length - 1]}. Reason: ${err.reason}]\n\nOriginal request: ${input}`;
        } else {
          throw err;
        }
      }
    }

    if (!lastOutput) {
      throw new Error(`Maximum handoffs (${maxHandoffs}) exceeded. Chain: ${chain.join(" → ")}`);
    }

    this.eventBus.emit("handoff.complete" as any, {
      runId: ctx.runId,
      chain,
      finalAgent: chain[chain.length - 1],
    });

    return {
      text: lastOutput.text,
      toolCalls: lastOutput.toolCalls,
      usage: totalUsage,
    };
  }

  private buildMemberDescriptions(): string {
    return this.config.members
      .map((member) => {
        const desc =
          typeof member.instructions === "function"
            ? "(dynamic instructions)"
            : (member.instructions ?? "General-purpose agent");
        return `- ${member.name}: ${desc}`;
      })
      .join("\n");
  }

  private buildCoordinatorPrompt(_input: string, memberDescriptions: string, mode: "coordinate" | "route"): string {
    if (mode === "route") {
      return `You are a team coordinator. Based on the user's request, select the single most appropriate team member to handle it. Available members:\n${memberDescriptions}\n\nRespond with ONLY the member name, nothing else.`;
    }

    return `You are a team coordinator. Break down the user's request into subtasks and delegate to appropriate team members. Available members:\n${memberDescriptions}\n\nRespond with a JSON array of delegations: [{"memberId": "name", "task": "specific task"}]\n${this.config.instructions ? `\nAdditional instructions: ${this.config.instructions}` : ""}`;
  }

  private buildSynthesisPrompt(
    originalInput: string,
    memberOutputs: Array<{ memberId: string; output: RunOutput }>,
  ): string {
    const outputsText = memberOutputs.map((o) => `### ${o.memberId}\n${o.output.text}`).join("\n\n");

    return `Original request: ${originalInput}\n\nTeam member responses:\n${outputsText}\n\nSynthesize these responses into a single coherent answer.`;
  }

  private parseDelegationPlan(content: string): DelegationPlan[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // fall through
    }

    return this.config.members.map((m) => ({
      memberId: m.name,
      task: content,
    }));
  }

  private findMember(name: string): Agent | A2ARemoteAgent | undefined {
    return this.config.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  }
}
