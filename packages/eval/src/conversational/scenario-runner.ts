import { randomUUID } from "node:crypto";
import type { Agent, ModelProvider, RunOutput } from "@agentium/core";
import { evaluateCase, positive, successful, validateScore, validateScorers } from "../case-lifecycle.js";
import type { Scorer, ScorerResult } from "../types.js";
import { SyntheticUser } from "./synthetic-user.js";
import { scoreTrajectory } from "./trajectory-scorer.js";
import type { ConversationEvalResult, ConversationScenario, ConversationTurn } from "./types.js";

export class ConversationRunner {
  constructor(private defaultModel: ModelProvider) {}
  async run(
    agent: Agent,
    scenario: ConversationScenario,
    scorers?: Scorer[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ConversationEvalResult> {
    validateScorers(scorers ?? []);
    positive(scenario.persona.maxTurns ?? 20, "maxTurns");
    if (!scenario.successCriteria.trim()) throw new Error("Conversation success criteria must not be empty");
    const turns: ConversationTurn[] = [];
    let trajectoryMatch: ConversationEvalResult["trajectoryMatch"];
    const sessionId = `eval-${randomUUID()}`;
    const result = await evaluateCase(
      { name: scenario.name, input: scenario.initialMessage },
      options.timeoutMs ?? 30000,
      options.signal,
      async (life) => {
        const synthetic = new SyntheticUser(scenario.persona, this.defaultModel);
        let message = scenario.initialMessage;
        let goal = false;
        let output: RunOutput | undefined;
        for (let turn = 0; turn < (scenario.persona.maxTurns ?? 20) && !goal; turn++) {
          life.check();
          turns.push({ role: "user", content: message });
          output = await life.agent(agent, { name: scenario.name, input: message, runOpts: { sessionId } });
          turns.push({ role: "assistant", content: output.text, toolCalls: output.toolCalls.map((tc) => tc.toolName) });
          if (!successful(output))
            return {
              output,
              scores: { completion: { score: 0, pass: false, reason: `Run ended with status ${output.status}` } },
              pass: false,
            };
          const next = await life.wait(() =>
            synthetic.generateMessage(
              turns.map((t) => ({ role: t.role, content: t.content })),
              life,
            ),
          );
          goal = next.goalComplete;
          message = next.message;
        }
        const scores: Record<string, ScorerResult> = Object.create(null);
        for (const scorer of scorers ?? []) {
          life.check();
          try {
            scores[scorer.name] = validateScore(
              await life.wait(() => scorer.score(scenario.initialMessage, output!, scenario.successCriteria, life)),
            );
          } catch (error) {
            life.check();
            scores[scorer.name] = {
              score: 0,
              pass: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (scenario.expectedTrajectory) trajectoryMatch = scoreTrajectory(turns, scenario.expectedTrajectory);
        return {
          output,
          scores,
          pass: goal && (trajectoryMatch?.pass ?? true) && Object.values(scores).every((s) => s.pass),
        };
      },
    );
    return { ...result, turns: [...turns], trajectoryMatch, turnCount: turns.filter((t) => t.role === "user").length };
  }
  async runComparison(
    agentA: Agent,
    agentB: Agent,
    scenario: ConversationScenario,
    scorers?: Scorer[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    const [resultA, resultB] = await Promise.all([
      this.run(agentA, scenario, scorers, options),
      this.run(agentB, scenario, scorers, options),
    ]);
    let winner: "A" | "B" | "tie" = "tie";
    if (resultA.pass && !resultB.pass) winner = "A";
    else if (resultB.pass && !resultA.pass) winner = "B";
    else if (resultA.pass && resultB.pass && resultA.turnCount !== resultB.turnCount)
      winner = resultA.turnCount < resultB.turnCount ? "A" : "B";
    return { scenarioName: scenario.name, resultA, resultB, winner };
  }
}
