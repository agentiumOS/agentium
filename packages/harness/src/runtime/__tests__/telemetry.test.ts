import { EventBus, type ModelProvider } from "@agentium/core";
import { expect, it } from "vitest";
import { type ExecutionDriver, HarnessRuntime } from "../driver.js";

const provider: ModelProvider = {
  providerId: "fixture",
  modelId: "fixture",
  async generate() {
    return {
      message: { role: "assistant", content: "private output" },
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      finishReason: "stop",
      raw: {},
    };
  },
  async *stream() {
    yield { type: "text", text: "private output" };
    yield { type: "finish", finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
  },
};
const driver = (start: ExecutionDriver["start"]): ExecutionDriver => ({
  id: "custom",
  version: 1,
  capabilities: { durable: false, controlledExecution: true, controls: [], policyCoverage: "local" },
  start,
});
const start = { identity: { tenantId: "tenant", userId: "actor" }, sessionId: "telemetry" };

it("observes custom drivers, controllers and direct calls once without capturing private content", async () => {
  const telemetry = new EventBus();
  const observed: Array<{ event: string; data: any }> = [];
  telemetry.onAny((event, data) => observed.push({ event, data }));
  telemetry.onAny(() => {
    throw new Error("observer failure");
  });
  const runtime = new HarnessRuntime({
    telemetry,
    grants: { toolIds: [], modelRoles: ["main", "critic"] },
    models: { critic: { provider } },
    controller: {
      id: "controller",
      prepareRun: async () => undefined,
      prepareStep: async () => ({ modelRole: "main" }),
    },
    completionPolicy: { id: "accept", evaluate: async () => ({ action: "accept", reason: "private explanation" }) },
    driver: driver(async (_request, services) => {
      await services.model(provider, [{ role: "user", content: "private prompt" }]);
      await services.controlModel("critic", [{ role: "user", content: "private critic" }]);
      for await (const _chunk of services.streamModel(provider, [])) {
        /* consume */
      }
      return { text: "private result" };
    }),
  });
  const result = await runtime.run("private input", start);
  expect(result.status).toBe("completed");
  const begins = observed.filter((item) => item.event === "model.start");
  const ends = observed.filter((item) => item.event === "model.result");
  expect(begins).toHaveLength(3);
  expect(ends).toHaveLength(3);
  expect(new Set(begins.map((item) => item.data.modelCallId)).size).toBe(3);
  expect(ends.map((item) => item.data.modelCallId)).toEqual(begins.map((item) => item.data.modelCallId));
  expect(observed.filter((item) => item.event === "controller.result").map((item) => item.data.decision)).toEqual([
    "continue",
    "continue",
    "continue",
    "accept",
  ]);
  expect(observed[0].event).toBe("run.start");
  expect(observed.at(-1)?.event).toBe("run.complete");
  expect(JSON.stringify(observed)).not.toContain("private");
  expect(result.usage.totalTokens).toBe(9);
});

it("balances direct model failures and controller failures with terminal run observations", async () => {
  for (const where of ["model", "controller"]) {
    const bus = new EventBus();
    const observed: string[] = [];
    bus.onAny((event) => observed.push(event));
    const runtime = new HarnessRuntime({
      telemetry: bus,
      grants: { toolIds: [], modelRoles: ["main"] },
      ...(where === "controller"
        ? {
            controller: {
              id: "broken",
              prepareRun: async () => {
                throw new Error("private");
              },
            },
          }
        : {}),
      driver: driver(async (_request, services) => {
        await services.model(
          {
            ...provider,
            generate: async () => {
              throw new Error("private");
            },
          },
          [],
        );
        return { text: "unreachable" };
      }),
    });
    expect((await runtime.run("input", start)).status).toBe("failed");
    expect(observed).toEqual(["run.start", `${where}.start`, `${where}.error`, "run.complete"]);
  }
});

it("labels a controller that ignores cancellation as cancelled when it finally resolves", async () => {
  const bus = new EventBus();
  const events: Array<{ event: string; data: any }> = [];
  bus.onAny((event, data) => events.push({ event, data }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new HarnessRuntime({
    telemetry: bus,
    grants: { toolIds: [], modelRoles: [] },
    controller: {
      id: "slow",
      prepareRun: async () => {
        await pending;
        return undefined;
      },
    },
    driver: driver(async () => ({ text: "unreachable" })),
  });
  const handle = runtime.start("input", start);
  await expect.poll(() => events.some(({ event }) => event === "controller.start")).toBe(true);
  handle.cancel();
  release();
  expect((await handle.result()).status).toBe("cancelled");
  expect(events.find(({ event }) => event === "controller.error")?.data.status).toBe("cancelled");
  expect(events.some(({ event }) => event === "controller.result")).toBe(false);
});
