import { randomUUID } from "node:crypto";
import {
  type ExecutionDriver,
  type HarnessResult,
  HarnessRuntime,
  type HarnessRuntimeConfig,
} from "./runtime/index.js";

/** No test-framework dependency. Calls the driver once and throws on violated public lifecycle invariants. */
export async function testDriverContract(
  driver: ExecutionDriver,
  config: Omit<HarnessRuntimeConfig, "driver"> = { grants: { toolIds: [], modelRoles: ["main"] } },
): Promise<{ result: HarnessResult; eventCount: number }> {
  const runtime = new HarnessRuntime({ ...config, driver });
  const identity = { tenantId: "fixture", userId: "fixture" };
  const sessionId = `conformance:${randomUUID()}`;
  const handle = runtime.start("Conformance fixture", { identity, sessionId });
  let failed = false;
  let failure: unknown;
  let report: { result: HarnessResult; eventCount: number } | undefined;
  try {
    const events = [];
    for await (const event of handle.events()) events.push(event);
    const result = await handle.result();
    const terminal = events.filter((event) => event.payload.type === "run.terminal");
    if (terminal.length !== 1 || terminal[0].payload.type !== "run.terminal")
      throw new Error("Expected exactly one terminal event");
    if (JSON.stringify(terminal[0].payload.result) !== JSON.stringify(result))
      throw new Error("Terminal result differs from settled result");
    if (
      events.some(
        (event, index) => event.sequence !== index + 1 || event.runId !== handle.runId || event.schemaVersion !== 1,
      )
    )
      throw new Error("Invalid event identity/ordering");
    if (result.finalCursor !== events.at(-1)?.sequence) throw new Error("Invalid final event cursor");
    if (result.status === "failed") throw new Error(`Driver fixture failed: ${result.reason?.message}`);
    const viewer = handle.events({ after: result.finalCursor });
    if (!(await viewer.next()).done) throw new Error("Terminal event stream remained open");
    handle.cancel("Late cancellation must not replace success");
    if (JSON.stringify(await handle.result()) !== JSON.stringify(result)) throw new Error("Settled result changed");
    report = { result, eventCount: events.length };
  } catch (error) {
    failed = true;
    handle.cancel("Driver conformance failed");
    failure = error;
  } finally {
    await handle.result().catch(() => {});
    try {
      const failures = await runtime.resources.closeSession(identity, sessionId);
      if (failures.length && !failed) {
        failed = true;
        failure = new Error(`Driver fixture resource cleanup failed: ${failures.join(", ")}`);
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  if (!report) throw new Error("Driver fixture did not produce a result");
  return report;
}
