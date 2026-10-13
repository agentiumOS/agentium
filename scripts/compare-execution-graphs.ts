import { Agent, type ChatMessage, type ModelProvider, type ToolDef, Workflow } from "@agentium/core";
import { agentDriver, workflowDriver } from "@agentium/harness";
import { createHarnessEvalTarget } from "@agentium/harness/testing";
import { z } from "zod/v3";

/** Offline structural comparison only. Run after building core and harness:
 * npx tsx scripts/compare-execution-graphs.ts
 * No paid provider, external write, judge, or production speedup estimate. */
const taskSchema = z.object({ id: z.string(), dependsOn: z.array(z.string()), literal: z.number().optional() });
const inputSchema = z.object({ target: z.string(), tasks: z.array(taskSchema) });
const receiptSchema = z.object({ task: z.string(), value: z.number() });
type Task = z.infer<typeof taskSchema>;
type Case = { id: string; tasks: Task[]; finalTask: string; expected: number };

const cases: Case[] = [
  {
    id: "chain-v1",
    tasks: [
      { id: "A", dependsOn: [], literal: 2 },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ],
    finalTask: "C",
    expected: 2,
  },
  {
    id: "fan-out-v1",
    tasks: [
      { id: "A", dependsOn: [], literal: 2 },
      { id: "B", dependsOn: [], literal: 3 },
      { id: "C", dependsOn: ["A", "B"] },
    ],
    finalTask: "C",
    expected: 5,
  },
  {
    id: "cross-dependency-v1",
    tasks: [
      { id: "A", dependsOn: [], literal: 2 },
      { id: "B", dependsOn: [], literal: 3 },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["A", "B"] },
      { id: "E", dependsOn: ["C", "D"] },
    ],
    finalTask: "E",
    expected: 7,
  },
];

const fixtureVersion = "execution-graphs-comparison-v1";
const usage = { promptTokens: 2, completionTokens: 1, totalTokens: 3 };
const budgets = { maxModelCalls: 16, maxToolCalls: 16, maxTokens: 128, maxRevisions: 0 };
const identity = { tenantId: "offline-fixture", userId: "offline-fixture" };
const instructions =
  "Execute the supplied task manifest with execute_task. Each task requires its declared prerequisites. Return the requested task's numeric value.";

function input(messages: readonly ChatMessage[]) {
  const user = [...messages].reverse().find((message) => message.role === "user");
  return inputSchema.parse(JSON.parse(z.string().parse(user?.content)));
}

function createFixture(testCase: Case) {
  const values = new Map<string, number>();
  const effects: Array<{ task: string; prerequisites: string[]; value: number }> = [];
  const modelRequests: Array<{ target: string; completed: string[]; requested: string[] }> = [];
  let active = 0;
  let peak = 0;
  let dependencyViolations = 0;
  let duplicateEffects = 0;
  const provider: ModelProvider = {
    providerId: fixtureVersion,
    modelId: "task-keyed-offline-v1",
    async generate(messages) {
      const request = input(messages);
      const receipts = messages
        .filter((message) => message.role === "tool")
        .map((message) => receiptSchema.parse(JSON.parse(z.string().parse(message.content))));
      const completed = new Map(receipts.map((receipt) => [receipt.task, receipt.value]));
      const target = request.target === "loop" ? testCase.finalTask : request.target;
      const final = completed.get(target);
      if (final !== undefined) {
        modelRequests.push({ target: request.target, completed: [...completed.keys()], requested: [] });
        return { message: { role: "assistant", content: String(final) }, finishReason: "stop", usage, raw: {} };
      }
      const ready =
        request.target === "loop"
          ? request.tasks.filter((task) => !completed.has(task.id) && task.dependsOn.every((id) => completed.has(id)))
          : request.tasks.filter((task) => task.id === target);
      if (!ready.length) throw new Error("Fixture manifest has no admissible task");
      modelRequests.push({
        target: request.target,
        completed: [...completed.keys()],
        requested: ready.map((task) => task.id),
      });
      return {
        message: {
          role: "assistant",
          content: null,
          toolCalls: ready.map((task) => ({
            id: `task:${task.id}`,
            name: "execute_task",
            arguments: { task: task.id },
          })),
        },
        finishReason: "tool_calls",
        usage,
        raw: {},
      };
    },
    async *stream() {},
  };
  const tool: ToolDef = {
    name: "execute_task",
    description: "Compute one isolated fixture value from its settled explicit prerequisites",
    parameters: z.object({ task: z.string() }),
    async execute(args) {
      const { task: id } = z.object({ task: z.string() }).parse(args);
      const task = testCase.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Unregistered task ${id}`);
      if (values.has(id)) {
        duplicateEffects++;
        throw new Error(`Duplicate fixture task ${id}`);
      }
      if (task.dependsOn.some((dependency) => !values.has(dependency))) {
        dependencyViolations++;
        throw new Error(`Premature fixture task ${id}`);
      }
      active++;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        const value =
          task.literal ??
          task.dependsOn.reduce((sum, dependency) => {
            const prerequisite = values.get(dependency);
            if (prerequisite === undefined) throw new Error(`Unsettled prerequisite ${dependency}`);
            return sum + prerequisite;
          }, 0);
        values.set(id, value);
        effects.push({ task: id, prerequisites: [...task.dependsOn], value });
        return JSON.stringify({ task: id, value });
      } finally {
        active--;
      }
    },
  };
  const config = (name: string) => ({
    name,
    model: provider,
    tools: [tool],
    instructions,
    maxToolRoundtrips: 4,
    maxTokens: 4,
    register: false,
  });
  return {
    config,
    effects,
    modelRequests,
    diagnostics: () => ({ peakConcurrentPrimitiveTasks: peak, dependencyViolations, duplicateEffects }),
  };
}

async function run(testCase: Case, condition: "loop" | "graph") {
  const fixture = createFixture(testCase);
  const agents: Agent[] = [];
  const driver =
    condition === "loop"
      ? agentDriver(fixture.config("loop"))
      : workflowDriver(
          new Workflow<Record<string, unknown>>({
            name: `${testCase.id}:graph`,
            initialState: {},
            register: false,
            steps: [
              {
                name: "episode",
                maxConcurrency: 2,
                graph: testCase.tasks.map((task) => {
                  const agent = new Agent(fixture.config(task.id));
                  agents.push(agent);
                  return {
                    id: task.id,
                    inputsFrom: task.dependsOn,
                    step: {
                      name: task.id,
                      agent,
                      inputFrom: () => JSON.stringify({ target: task.id, tasks: testCase.tasks }),
                    },
                  };
                }),
              },
            ],
          }),
        );
  const target = createHarnessEvalTarget({
    identity,
    config: {
      driver,
      grants: { toolIds: ["execute_task"], modelRoles: ["main"] },
      budgets,
      estimateInputTokens: () => 2,
    },
  });
  const started = performance.now();
  try {
    const output = await target.run(
      condition === "loop" ? JSON.stringify({ target: "loop", tasks: testCase.tasks }) : "{}",
    );
    const observation = target.observation(output);
    const state = z.record(z.string(), z.unknown()).safeParse(output.structured);
    const graphOutput = state.success ? state.data[`${testCase.finalTask}_output`] : undefined;
    const normalized = condition === "loop" ? output.text : typeof graphOutput === "string" ? graphOutput : null;
    const diagnostic = fixture.diagnostics();
    const reservationsSettled =
      observation?.budget?.modelCalls.reserved === 0 && observation.budget.tokens.reserved === 0;
    const correctness =
      output.status === "completed" &&
      normalized === String(testCase.expected) &&
      diagnostic.dependencyViolations === 0 &&
      diagnostic.duplicateEffects === 0 &&
      fixture.effects.length === testCase.tasks.length &&
      reservationsSettled;
    return {
      caseId: testCase.id,
      condition,
      correctness,
      status: output.status,
      reason: output.reason,
      expected: String(testCase.expected),
      normalizedOutput: normalized,
      rawOutput: output.text,
      modelCalls: observation?.budget?.modelCalls.used,
      toolAdmissions: observation?.budget?.toolCalls.used,
      tokens: observation?.budget?.tokens.used,
      unknownUsageCalls: observation?.budget?.unknownUsageCalls,
      reservedModelCalls: observation?.budget?.modelCalls.reserved,
      reservedTokens: observation?.budget?.tokens.reserved,
      observationCoverage: observation?.toolCallCoverage,
      localWallTimeMs: performance.now() - started,
      ...diagnostic,
      effects: fixture.effects,
      modelRequests: fixture.modelRequests,
      cost: { providerChargesUSD: 0, productionCostUSD: null },
    };
  } finally {
    await Promise.all(agents.map((agent) => agent.close()));
  }
}

const results = [];
for (const testCase of cases) {
  for (const condition of ["loop", "graph"] as const) {
    try {
      results.push(await run(testCase, condition));
    } catch (error) {
      results.push({
        caseId: testCase.id,
        condition,
        correctness: false,
        status: "infrastructure_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
process.stdout.write(
  `${JSON.stringify(
    {
      fixtureVersion,
      model: "task-keyed-offline-v1",
      budgets,
      agentLimits: { maxToolRoundtrips: 4, maxTokens: 4 },
      graphMaxConcurrency: 2,
      declaredUsagePerModelCall: usage,
      conditions:
        "Identical task manifests, provider implementation, primitive tool, host grants, budgets, and per-Agent limits; isolated state per condition",
      limits:
        "One deterministic run per condition/case. Local wall time is diagnostic overhead with zero simulated provider latency. Existing loop may issue concurrent tools. No live model quality, variability, billing, production latency, or speedup claim.",
      decision: results.every((result) => result.correctness)
        ? "covered exact outcomes pass"
        : "covered exact outcome failure",
      results,
    },
    null,
    2,
  )}\n`,
);
if (results.some((result) => !result.correctness)) process.exitCode = 1;
