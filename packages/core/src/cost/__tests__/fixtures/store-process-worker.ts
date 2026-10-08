import type { BudgetPolicy, UsageObservation } from "../../accounting-types.js";
import { budgetScopes } from "../../budget.js";
import { CostTracker } from "../../cost-tracker.js";
import type { AccountingStore } from "../../store.js";
import { PostgresUsageStore } from "../../stores/postgres.js";
import { SqliteUsageStore } from "../../stores/sqlite.js";
import { validateNormalizedUsage } from "../../usage.js";
import { fixtureCatalog, fixtureRecord } from "../fixtures.js";

const [backend, location, tenantId, mode, attemptId = "attempt-1"] = process.argv.slice(2);
if (!location || !tenantId || !["sqlite", "postgres"].includes(backend ?? ""))
  throw new Error("Invalid fixture worker arguments");
const store: AccountingStore = backend === "sqlite" ? new SqliteUsageStore(location) : new PostgresUsageStore(location);
const budget: BudgetPolicy = {
  mode: "reservation",
  conservativeBound: "0.1",
  limits: [
    {
      scope: "tenant",
      amount: "1",
      currency: "USD",
      period: { start: "1970-01-01T00:00:00.000Z", end: "9999-01-01T00:00:00.000Z" },
    },
  ],
};
const tracker = new CostTracker({ catalog: fixtureCatalog(), store, budget });
const input = {
  ...fixtureRecord(attemptId),
  tenantId,
  observationId: `${attemptId}:terminal`,
  observedAt: "2026-10-08T12:00:00.000Z",
  reservationId: `${attemptId}:reservation`,
};
const scopes = budgetScopes(budget, { tenantId });

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("Fixture worker requires IPC"));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
async function report() {
  return {
    costs: await tracker.queryCosts({ tenantId }),
    observations: (await store.queryUsage({ tenantId, limit: 1000 })).items.length,
    assessments: (await store.queryAssessments({ tenantId, limit: 1000 })).items.length,
    balances: await store.balances(tenantId, scopes),
    reservation: await store.getReservation(tenantId, input.reservationId),
  };
}
async function pauseForKill() {
  await send({ type: "checkpoint", data: await report() });
  // IPC remains open. The parent terminates this process without close/flush handlers.
  await new Promise<void>(() => {});
}

try {
  const go = new Promise<void>((resolve) => process.once("message", () => resolve()));
  await send({ type: "ready" });
  await go;
  if (mode === "reserve") {
    const decision = await tracker.checkBudget({ tenantId, attemptId }, "0.7");
    await send({ type: "result", data: { accepted: decision.status === "allowed", decision } });
  } else if (mode === "crash-observation" || mode === "crash-settled") {
    const decision = await tracker.checkBudget({ tenantId, attemptId });
    if (decision.status !== "allowed") throw new Error("Fixture admission unexpectedly failed");
    if (mode === "crash-observation") {
      const observation: UsageObservation = {
        ...input,
        tenantId,
        sequence: 1,
        observationKind: "snapshot",
        usage: validateNormalizedUsage(input.usage),
      };
      await store.appendObservation(observation);
    } else {
      await tracker.recordUsage(input);
    }
    await pauseForKill();
  } else if (mode === "replay") {
    await tracker.recordUsage(input);
    await tracker.recordUsage(input);
    await send({ type: "result", data: await report() });
  } else if (mode === "query") {
    await send({ type: "result", data: await report() });
  } else throw new Error(`Unknown fixture worker mode: ${mode}`);
  await store.close?.();
  process.disconnect?.();
} catch (error) {
  await send({ type: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  await store.close?.();
  process.exitCode = 1;
  process.disconnect?.();
}
