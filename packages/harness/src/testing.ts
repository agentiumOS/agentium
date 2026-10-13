import { randomUUID } from "node:crypto";
import type { MessageContent, RunOpts, RunOutput, ToolCallResult } from "@agentium/core";
import { defineAbility, defineHarness, extendHarness } from "./definition.js";
import type { HarnessBudgetSnapshot } from "./runtime/budget.js";
import type {
  HarnessDefinition,
  HarnessIdentity,
  HarnessReason,
  HarnessStatus,
  LocalAbilityUse,
} from "./runtime/index.js";
import {
  type ExecutionDriver,
  type HarnessResult,
  HarnessRuntime,
  type HarnessRuntimeConfig,
  HarnessUnsupportedError,
  InMemoryHarnessSessionStore,
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

export interface HarnessEvalObservation {
  status: HarnessStatus;
  reason?: HarnessReason;
  budget?: HarnessBudgetSnapshot;
  toolCallCoverage: "complete" | "partial";
  cleanupDiagnostics?: readonly string[];
}
export interface HarnessEvalTarget {
  run(input: MessageContent, opts?: RunOpts): Promise<RunOutput>;
  /** Only recognizes this target's returned object; observations omit source bodies. */
  observation(output: RunOutput): HarnessEvalObservation | undefined;
}
export interface HarnessEvalTargetOptions {
  config: HarnessRuntimeConfig;
  identity: HarnessIdentity;
  maxObservedTools?: number;
  maxObservationBytes?: number;
}

function observationLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}
/** Preserve host ability methods and their receivers when extending declarative containers. */
function captureAbility(use: LocalAbilityUse): LocalAbilityUse {
  return {
    instanceId: use.instanceId,
    validate: use.validate.bind(use),
    describe: use.describe.bind(use),
    bind: use.bind.bind(use),
    ...(use.portable ? { portable: use.portable } : {}),
    ...(use.factory ? { factory: use.factory } : {}),
  };
}
function captureDefinition(definition?: HarnessDefinition): HarnessDefinition {
  if (!definition) return defineHarness({});
  return definition.kind === "local"
    ? defineHarness({ ...definition, abilities: definition.abilities.map(captureAbility) })
    : defineHarness(definition);
}

/** Optional evaluation seam: authority/model configuration belongs to the verified host. */
export function createHarnessEvalTarget(options: HarnessEvalTargetOptions): HarnessEvalTarget {
  const identity = Object.freeze({ tenantId: options.identity.tenantId, userId: options.identity.userId });
  if (!identity.tenantId?.trim() || !identity.userId?.trim()) throw new TypeError("Verified identity is required");
  const maxObservedTools = observationLimit(options.maxObservedTools ?? 128, "maxObservedTools");
  const maxObservationBytes = observationLimit(options.maxObservationBytes ?? 65536, "maxObservationBytes");
  const definition = captureDefinition(options.config.definition);
  const config: HarnessRuntimeConfig = {
    ...options.config,
    definition,
    tools: options.config.tools && [...options.config.tools],
    requirements: options.config.requirements && [...options.config.requirements],
    budgets: options.config.budgets && { ...options.config.budgets },
    grants: {
      ...options.config.grants,
      toolIds: [...options.config.grants.toolIds],
      modelRoles: [...options.config.grants.modelRoles],
      requiredToolIds: options.config.grants.requiredToolIds && [...options.config.grants.requiredToolIds],
    },
    models:
      options.config.models &&
      Object.fromEntries(
        Object.entries(options.config.models).map(([role, binding]) => [
          role,
          { ...binding, options: binding.options && [...binding.options] },
        ]),
      ),
    sessionStore: options.config.sessionStore ?? new InMemoryHarnessSessionStore(),
  };
  // Constructor validates configuration without binding abilities or starting model/tool work.
  new HarnessRuntime(config);
  const observations = new WeakMap<RunOutput, HarnessEvalObservation>();
  return {
    async run(input, opts = {}) {
      const supported = new Set(["sessionId", "signal", "runMode", "userId", "tenantId"]);
      for (const key of Reflect.ownKeys(opts)) {
        if (typeof key !== "string" || (!supported.has(key) && Reflect.get(opts, key) !== undefined))
          throw new HarnessUnsupportedError(
            `evaluation RunOpts.${String(key)}; configure authority, models and history on the host harness`,
          );
      }
      if (
        (opts.userId !== undefined && opts.userId !== identity.userId) ||
        (opts.tenantId !== undefined && opts.tenantId !== identity.tenantId)
      )
        throw new HarnessUnsupportedError("evaluation identity override; use the target's fixed verified identity");
      const sessionId = opts.sessionId ?? `eval-${randomUUID()}`;
      const seen: ToolCallResult[] = [];
      let coverage: HarnessEvalObservation["toolCallCoverage"] = "complete";
      let bytes = 0;
      const observer = defineAbility<undefined>({
        type: "agentium/testing-tool-observations",
        validate: (value) => value,
        describe: () => ({ toolNames: [], requirements: [] }),
        bind: () => ({
          tools: [],
          middleware: [
            {
              id: `agentium/testing-tool-observations:${randomUUID()}`,
              observeToolSettlement(result) {
                if (coverage === "partial") return;
                const observed: ToolCallResult = {
                  toolCallId: result.toolCallId,
                  toolName: result.toolName,
                  result: "Tool outcome observed; source payload not retained by this adapter",
                  ...(result.error !== undefined ? { error: result.error } : {}),
                  ...(result.denial !== undefined ? { denial: result.denial } : {}),
                };
                const size = Buffer.byteLength(JSON.stringify(observed), "utf8");
                if (seen.length >= maxObservedTools || bytes + size > maxObservationBytes) {
                  coverage = "partial";
                  return;
                }
                seen.push(observed);
                bytes += size;
              },
            },
          ],
        }),
      });
      const runtime = new HarnessRuntime({
        ...config,
        definition: extendHarness(definition, { abilities: [observer(undefined)] }),
      });
      const started = Date.now();
      const result = await runtime.run(input, { identity, sessionId, signal: opts.signal, runMode: opts.runMode });
      const cleanup = [...(result.cleanupDiagnostics ?? [])];
      if (!config.resources) {
        try {
          cleanup.push(...(await runtime.resources.closeSession(identity, sessionId)));
        } catch {
          cleanup.push("eval_resource_cleanup_failed");
        }
      }
      if (
        result.status === "failed" ||
        result.status === "cancelled" ||
        cleanup.some((item) => item.includes("tool_observation_failed"))
      )
        coverage = "partial";
      const output: RunOutput = {
        text: result.text,
        structured: result.structured,
        usage: result.usage,
        runId: result.runId,
        sessionId: result.sessionId,
        userId: identity.userId,
        toolCalls: seen,
        status: result.status === "failed" ? "error" : result.status === "awaiting_input" ? "stopped" : result.status,
        reason: result.reason,
        partial: result.partial,
        providerFinishReason: result.providerFinishReason,
        durationMs: Date.now() - started,
      };
      observations.set(output, {
        status: result.status,
        reason: result.reason,
        budget: result.budget,
        toolCallCoverage: coverage,
        ...(cleanup.length ? { cleanupDiagnostics: cleanup } : {}),
      });
      return output;
    },
    observation(output) {
      const result = observations.get(output);
      return result && structuredClone(result);
    },
  };
}
