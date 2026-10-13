import {
  type DurableGraphJournal,
  type DurableGraphState,
  type DurableJSON,
  durableCanonical,
  durableDigest,
  type RootExecutionController,
} from "@agentium/core";
import { z } from "zod/v3";
import { ExecutionPlanValidationError } from "./execution-proposal.js";
import type { ValidatedExecutionPlan, ValidatedPlanCommitFrame } from "./graph-contracts.js";

export interface MaterializedExecutionPlan {
  validated: ValidatedExecutionPlan;
  nodeKeys: Record<string, string>;
}

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    if (!value.trim() || ["__proto__", "constructor", "prototype"].includes(value)) return false;
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  });
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const jsonSchema: z.ZodType<DurableJSON> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
);
const nodeSchema = z
  .object({
    id: identity,
    binding: identity,
    version: identity,
    args: z.record(jsonSchema),
    dependsOn: z.array(identity).optional(),
    inputsFrom: z.array(identity).optional(),
  })
  .strict();
const validatedSchema = z
  .object({
    plan: z
      .object({
        schemaVersion: z.literal(1),
        revision: integer.refine((value) => value > 0),
        nodes: z.array(nodeSchema),
        maxConcurrency: integer.refine((value) => value > 0).optional(),
        merge: z.enum(["error", "declaration_order"]).optional(),
      })
      .strict(),
    order: z.array(identity),
    referenceRequirements: z.array(
      z
        .object({
          consumer: identity,
          producer: identity,
          outputPath: z.array(z.string()),
          argumentPath: z.array(z.string()),
        })
        .strict(),
    ),
    digest: identity,
    catalogDigest: identity,
    bindingKinds: z.record(identity, z.enum(["tool", "agent", "graph", "repeat"])),
  })
  .strict();
const materializedSchema = z.object({ validated: validatedSchema, nodeKeys: z.record(identity, identity) }).strict();

function asJSON(value: unknown): DurableJSON {
  return jsonSchema.parse(JSON.parse(durableCanonical(value)));
}
function requireScope(scope: string): void {
  identity.parse(scope);
  identity.parse(`plan:${scope}`);
}
function revisionKey(scope: string, revision: number): string {
  const key = `${scope}/revision/${revision}`;
  identity.parse(key);
  return key;
}
function assertValidated(validated: ValidatedExecutionPlan, catalogDigest: string): void {
  if (validated.catalogDigest !== catalogDigest || validated.digest !== durableDigest(validated.plan))
    throw new ExecutionPlanValidationError("Materialized plan catalog or content digest mismatch");
  const ids = validated.plan.nodes.map((node) => node.id);
  if (
    new Set(ids).size !== ids.length ||
    validated.order.length !== ids.length ||
    new Set(validated.order).size !== ids.length ||
    validated.order.some((id) => !ids.includes(id))
  )
    throw new ExecutionPlanValidationError("Materialized plan node order is corrupt");
  const completed = new Set<string>();
  for (const id of validated.order) {
    const node = validated.plan.nodes.find((entry) => entry.id === id);
    if (
      !node ||
      !validated.bindingKinds[node.binding] ||
      [...(node.dependsOn ?? []), ...(node.inputsFrom ?? [])].some((dependency) => !completed.has(dependency))
    )
      throw new ExecutionPlanValidationError("Materialized plan binding or dependency order is invalid");
    completed.add(id);
  }
  for (const ref of validated.referenceRequirements) {
    const consumer = validated.plan.nodes.find((node) => node.id === ref.consumer);
    if (!consumer?.inputsFrom?.includes(ref.producer) || !ids.includes(ref.producer))
      throw new ExecutionPlanValidationError("Materialized plan reference requirements are corrupt");
  }
}
function parseMaterialized(value: unknown, state: DurableGraphState, scope: string): MaterializedExecutionPlan {
  const materialized = materializedSchema.parse(JSON.parse(durableCanonical(value)));
  assertValidated(materialized.validated, state.definition.catalogDigest);
  const nodes = materialized.validated.plan.nodes;
  if (
    Object.keys(materialized.nodeKeys).length !== nodes.length ||
    new Set(Object.values(materialized.nodeKeys)).size !== nodes.length
  )
    throw new ExecutionPlanValidationError("Materialized node identities are corrupt");
  for (const node of nodes) {
    const key = materialized.nodeKeys[node.id];
    const record = key && state.nodes[key];
    if (
      !record ||
      record.binding.id !== node.binding ||
      record.binding.version !== node.version ||
      record.binding.kind !== materialized.validated.bindingKinds[node.binding] ||
      record.metadata.scope !== scope ||
      record.metadata.nodeId !== node.id
    )
      throw new ExecutionPlanValidationError("Materialized plan node reservation is missing or incompatible");
  }
  return materialized;
}
function currentPlan(state: DurableGraphState, scope: string): MaterializedExecutionPlan | undefined {
  const value = state.metadata[`plan:${scope}`];
  if (value === undefined) return undefined;
  const current = parseMaterialized(value, state, scope);
  const retained = state.plans[revisionKey(scope, current.validated.plan.revision)];
  if (retained === undefined || durableCanonical(retained) !== durableCanonical(value))
    throw new ExecutionPlanValidationError("Materialized pointer differs from its immutable committed revision");
  return current;
}
function protectedNode(state: DurableGraphState, key: string): boolean {
  const record = state.nodes[key];
  return record?.status !== "pending" || record.attempts.length > 0 || record.inputDigest !== undefined;
}
function preflight(
  state: DurableGraphState,
  now: number,
  scope: string,
  frame: ValidatedPlanCommitFrame,
): {
  materialized: MaterializedExecutionPlan;
  existing: boolean;
  newKeys: string[];
  previous?: MaterializedExecutionPlan;
} {
  if (state.cancellation.requested) throw new ExecutionPlanValidationError("Durable planning cancellation requested");
  if (state.definition.deadline !== undefined && now >= state.definition.deadline)
    throw new ExecutionPlanValidationError("Original durable planning deadline exceeded");
  assertValidated(frame.validated, state.definition.catalogDigest);
  const key = revisionKey(scope, frame.validated.plan.revision);
  const existing = state.plans[key];
  if (existing !== undefined) {
    const materialized = parseMaterialized(existing, state, scope);
    if (durableCanonical(materialized.validated) !== durableCanonical(frame.validated))
      throw new ExecutionPlanValidationError("Committed plan revision reused with different content");
    return { materialized, existing: true, newKeys: [] };
  }
  const previous = currentPlan(state, scope);
  if ((previous?.validated.plan.revision ?? 0) !== frame.baseRevision)
    throw new ExecutionPlanValidationError("Plan base revision is obsolete");
  const nextById = new Map(frame.validated.plan.nodes.map((node) => [node.id, node]));
  let protectedWork = false;
  for (const node of previous?.validated.plan.nodes ?? []) {
    const oldKey = previous?.nodeKeys[node.id];
    if (!oldKey) throw new ExecutionPlanValidationError("Missing prior node incarnation");
    if (protectedNode(state, oldKey)) {
      protectedWork = true;
      const next = nextById.get(node.id);
      if (
        !next ||
        durableCanonical(next) !== durableCanonical(node) ||
        frame.validated.bindingKinds[next.binding] !== previous?.validated.bindingKinds[node.binding]
      )
        throw new ExecutionPlanValidationError("Plan revision cannot change or remove claimed operation definitions");
    }
  }
  if (protectedWork && (previous?.validated.plan.merge ?? "error") !== (frame.validated.plan.merge ?? "error"))
    throw new ExecutionPlanValidationError("Plan revision cannot change merge semantics after claimed work");
  if (protectedWork && frame.validated.plan.merge === "declaration_order") {
    const priorOrder =
      previous?.validated.plan.nodes
        .filter((node) => protectedNode(state, previous.nodeKeys[node.id]))
        .map((node) => node.id) ?? [];
    const nextOrder = frame.validated.plan.nodes.filter((node) => priorOrder.includes(node.id)).map((node) => node.id);
    if (durableCanonical(priorOrder) !== durableCanonical(nextOrder))
      throw new ExecutionPlanValidationError("Plan revision cannot reorder claimed state writers");
  }
  const nodeKeys: Record<string, string> = {};
  const newKeys: string[] = [];
  for (const node of frame.validated.plan.nodes) {
    const prior = previous?.validated.plan.nodes.find((entry) => entry.id === node.id);
    const oldKey = previous?.nodeKeys[node.id];
    const unchanged =
      prior &&
      durableCanonical(prior) === durableCanonical(node) &&
      previous?.validated.bindingKinds[node.binding] === frame.validated.bindingKinds[node.binding];
    const nodeKey =
      unchanged && oldKey ? oldKey : `node:${durableDigest([scope, node.id, frame.validated.plan.revision, node])}`;
    nodeKeys[node.id] = nodeKey;
    if (!unchanged) {
      if (state.nodes[nodeKey])
        throw new ExecutionPlanValidationError("New node incarnation already has durable evidence");
      newKeys.push(nodeKey);
    }
  }
  return {
    materialized: { validated: frame.validated, nodeKeys },
    existing: false,
    newKeys,
    ...(previous ? { previous } : {}),
  };
}

/** Persist validated topology and pending node incarnations in one fenced commit. */
export async function commitExecutionPlan(
  journal: DurableGraphJournal,
  root: RootExecutionController,
  scope: string,
  frame: ValidatedPlanCommitFrame,
): Promise<MaterializedExecutionPlan> {
  try {
    requireScope(scope);
    const supplied = z
      .object({ baseRevision: integer, validated: validatedSchema })
      .strict()
      .parse(JSON.parse(durableCanonical(frame)));
    if (supplied.validated.plan.revision !== supplied.baseRevision + 1)
      throw new ExecutionPlanValidationError("Plan revision must advance its exact base by one");
    let admission: ReturnType<typeof preflight> | undefined;
    await journal.mutate((state, now) => {
      admission = preflight(state, now, scope, supplied);
    });
    if (!admission) throw new ExecutionPlanValidationError("Plan preflight produced no admission decision");
    if (admission.existing) return structuredClone(admission.materialized);
    const revisionAdmission = `${scope}/${supplied.validated.plan.revision}/${supplied.validated.digest}`;
    identity.parse(revisionAdmission);
    await root.revision(revisionAdmission);
    await root.expand(admission.newKeys);
    const committed = await journal.mutate((state, now) => {
      const checked = preflight(state, now, scope, supplied);
      if (checked.existing) return;
      for (const [id, oldKey] of Object.entries(checked.previous?.nodeKeys ?? {})) {
        if (checked.materialized.nodeKeys[id] !== oldKey) {
          const old = state.nodes[oldKey];
          if (!old || protectedNode(state, oldKey))
            throw new ExecutionPlanValidationError("Pending incarnation was claimed during plan commit");
          old.status = "superseded";
          old.metadata.supersededByRevision = supplied.validated.plan.revision;
        }
      }
      for (const node of supplied.validated.plan.nodes) {
        const nodeKey = checked.materialized.nodeKeys[node.id];
        if (checked.newKeys.includes(nodeKey))
          state.nodes[nodeKey] = {
            binding: { id: node.binding, version: node.version, kind: supplied.validated.bindingKinds[node.binding] },
            status: "pending",
            attempts: [],
            metadata: { scope, nodeId: node.id, planRevision: supplied.validated.plan.revision },
          };
      }
      const materialized = asJSON(checked.materialized);
      state.plans[revisionKey(scope, supplied.validated.plan.revision)] = materialized;
      state.metadata[`plan:${scope}`] = materialized;
    });
    const materialized = committed.plans[revisionKey(scope, supplied.validated.plan.revision)];
    if (materialized === undefined) throw new ExecutionPlanValidationError("Plan commit did not retain its revision");
    return parseMaterialized(materialized, committed, scope);
  } catch (cause) {
    if (
      cause instanceof ExecutionPlanValidationError ||
      (cause instanceof Error && "code" in cause && typeof cause.code === "string" && cause.code.startsWith("root_"))
    )
      throw cause;
    // Preserve lease/conflict classes so the adapter retains its recovery semantics.
    if (cause instanceof Error && (cause.name.includes("Lease") || cause.name.includes("Conflict"))) throw cause;
    throw new ExecutionPlanValidationError("Durable plan commit failed", { cause });
  }
}
/** Read only an immutable revision whose reservations and pointer still validate. */
export async function readExecutionPlan(
  journal: DurableGraphJournal,
  scope: string,
): Promise<MaterializedExecutionPlan | undefined> {
  try {
    requireScope(scope);
    return currentPlan(await journal.snapshot(), scope);
  } catch (cause) {
    if (cause instanceof Error && (cause.name.includes("Lease") || cause.name.includes("Conflict"))) throw cause;
    throw new ExecutionPlanValidationError("Durable materialized plan is invalid", { cause });
  }
}
