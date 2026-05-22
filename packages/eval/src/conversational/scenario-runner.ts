import type { Agent, ModelProvider } from "@agentium/core";
import type { Scorer } from "../types.js";
import { SyntheticUser } from "./synthetic-user.js";
import { scoreTrajectory } from "./trajectory-scorer.js";
import type { ConversationEvalResult, ConversationScenario, ConversationTurn } from "./types.js";

export class ConversationRunner {
  private defaultModel: ModelProvider;

  constructor(model: ModelProvider) {
    this.defaultModel = model;
  }

  async run(agent: Agent, scenario: ConversationScenario, scorers?: Scorer[]): Promise<ConversationEvalResult> {
    const startTime = Date.now();
    const maxTurns = scenario.persona.maxTurns ?? 20;
    const turns: ConversationTurn[] = [];
    const syntheticUser = new SyntheticUser(scenario.persona, this.defaultModel);

    let currentMessage = scenario.initialMessage;
    let goalComplete = false;
    let lastOutput: any;
    const sessionId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      for (let turn = 0; turn < maxTurns && !goalComplete; turn++) {
        turns.push({ role: "user", content: currentMessage });

        const output = await agent.run(currentMessage, { sessionId });
        lastOutput = output;

        const toolCalls = output.toolCalls?.map((tc: any) => tc.name ?? tc.toolName) ?? [];
        turns.push({ role: "assistant", content: output.text, toolCalls });

        const userResponse = await syntheticUser.generateMessage(
          turns.map((t) => ({
            role: t.role,
            content: t.content,
          })),
        );

        goalComplete = userResponse.goalComplete;
        if (!goalComplete) {
          currentMessage = userResponse.message;
        }
      }

      const scores: Record<string, { score: number; pass: boolean; reason?: string }> = {};
      if (scorers && lastOutput) {
        for (const scorer of scorers) {
          try {
            scores[scorer.name] = await scorer.score(scenario.initialMessage, lastOutput, scenario.successCriteria);
          } catch {
            scores[scorer.name] = { score: 0, pass: false, reason: "Scorer error" };
          }
        }
      }

      let trajectoryMatch;
      if (scenario.expectedTrajectory) {
        trajectoryMatch = scoreTrajectory(turns, scenario.expectedTrajectory);
      }

      const allPass =
        goalComplete && (trajectoryMatch?.pass ?? true) && Object.values(scores).every((s) => s.pass !== false);

      return {
        caseName: scenario.name,
        input: scenario.initialMessage,
        output: lastOutput,
        scores,
        durationMs: Date.now() - startTime,
        pass: allPass,
        turns,
        trajectoryMatch,
        turnCount: turns.filter((t) => t.role === "user").length,
      };
    } catch (error) {
      return {
        caseName: scenario.name,
        input: scenario.initialMessage,
        scores: {},
        durationMs: Date.now() - startTime,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
        turns,
        turnCount: turns.filter((t) => t.role === "user").length,
      };
    }
  }

  async runComparison(
    agentA: Agent,
    agentB: Agent,
    scenario: ConversationScenario,
    scorers?: Scorer[],
  ): Promise<{
    scenarioName: string;
    resultA: ConversationEvalResult;
    resultB: ConversationEvalResult;
    winner: "A" | "B" | "tie";
  }> {
    const [resultA, resultB] = await Promise.all([
      this.run(agentA, scenario, scorers),
      this.run(agentB, scenario, scorers),
    ]);

    let winner: "A" | "B" | "tie" = "tie";
    if (resultA.pass && !resultB.pass) winner = "A";
    else if (!resultA.pass && resultB.pass) winner = "B";
    else if (resultA.turnCount < resultB.turnCount) winner = "A";
    else if (resultB.turnCount < resultA.turnCount) winner = "B";

    return { scenarioName: scenario.name, resultA, resultB, winner };
  }
}
