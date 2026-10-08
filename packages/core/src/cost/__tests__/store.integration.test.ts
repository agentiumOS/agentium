import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CostTracker } from "../cost-tracker.js";
import type { AccountingStore } from "../store.js";
import { PostgresUsageStore } from "../stores/postgres.js";
import { SqliteUsageStore } from "../stores/sqlite.js";
import { fixtureCatalog, fixtureContext, fixtureRecord } from "./fixtures.js";

async function contract(create: () => AccountingStore) {
  const tenantId = randomUUID();
  let first = create();
  const second = create();
  try {
    const tracker = new CostTracker({ catalog: fixtureCatalog(), store: first });
    await tracker.recordUsage({ ...fixtureRecord(), tenantId });
    await tracker.flush();
    await first.close?.();
    first = create();
    expect((await first.queryCosts({ tenantId })).total).toBe("0.072");
    expect((await second.queryCosts({ tenantId: `${tenantId}-other` })).total).toBe("0");
    const reservation = {
      tenantId,
      reservationId: "r1",
      attemptId: "a1",
      amount: "0.7",
      currency: "USD",
      scopes: [{ key: "scope", limit: "1" }],
      status: "reserved" as const,
      createdAt: fixtureContext.occurredAt,
    };
    const results = await Promise.all([
      first.reserve(reservation),
      second.reserve({ ...reservation, reservationId: "r2", attemptId: "a2" }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    const winner = results[0].accepted ? reservation : { ...reservation, reservationId: "r2", attemptId: "a2" };
    expect((await second.reserve(winner)).accepted).toBe(true);
    expect((await second.balances(tenantId, [{ key: "scope", limit: "1", currency: "USD" }]))[0].reserved).toBe("0.7");
    const replayer = new CostTracker({ catalog: fixtureCatalog(), store: second });
    await replayer.recordUsage({ ...fixtureRecord(), tenantId });
    expect((await first.queryCosts({ tenantId })).total).toBe("0.072");
  } finally {
    await first.close?.();
    await second.close?.();
  }
}
describe("durable accounting stores (disposable databases only)", () => {
  it("SQLite migrates, restarts, isolates tenants and admits one of two workers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentium-accounting-"));
    try {
      await contract(() => new SqliteUsageStore(join(directory, "usage.sqlite")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.AGENTIUM_COST_POSTGRES_TEST_URL)(
    "Postgres migrates, restarts, isolates tenants and admits one of two workers",
    async () => {
      await contract(() => new PostgresUsageStore(process.env.AGENTIUM_COST_POSTGRES_TEST_URL!));
    },
  );
});
