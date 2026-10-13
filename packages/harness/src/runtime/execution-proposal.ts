import { createHash } from "node:crypto";
import { type AgentiumSchema, convertJsonSchema, type DurableJSON } from "@agentium/core";
import { z } from "zod/v3";
import type {
  ExecutionGraphProgram,
  ExecutionPlan,
  ExecutionPlanNode,
  GraphBinding,
  GraphValueSchema,
  PlanReferenceRequirement,
  PlanValidationLimits,
  ValidatedExecutionPlan,
} from "./graph-contracts.js";

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const jsonSchema: z.ZodType<DurableJSON> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(jsonSchema)]),
);
const identity = z.string().min(1).max(512).refine(validIdentity, "Invalid execution identity");
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
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nodes: z.array(nodeSchema),
    maxConcurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    merge: z.enum(["error", "declaration_order"]).optional(),
  })
  .strict();
const referenceSchema = z.object({ $ref: z.object({ node: identity, path: z.array(z.string()) }).strict() }).strict();

export class ExecutionPlanValidationError extends Error {
  readonly code = "execution_plan_invalid";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionPlanValidationError";
  }
}

function validIdentity(value: string): boolean {
  if (!value.trim() || unsafeKeys.has(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
function requireIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 512 || !validIdentity(value))
    throw new ExecutionPlanValidationError(`Invalid ${label}`);
}
function positiveInteger(value: unknown, label: string, zero = false): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new ExecutionPlanValidationError(`${label} must be a ${zero ? "nonnegative" : "positive"} safe integer`);
}
function isJSONObject(value: DurableJSON): value is Record<string, DurableJSON> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Reject accessors and cycles before JSON/schema traversal can invoke untrusted data. */
function copyJSON(value: unknown, maxDepth: number, depth = 0, active = new Set<object>()): DurableJSON {
  if (depth > maxDepth) throw new ExecutionPlanValidationError(`Execution JSON exceeds depth ${maxDepth}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || active.has(value))
    throw new ExecutionPlanValidationError("Execution plans require finite, nonrecursive JSON data");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new ExecutionPlanValidationError("Execution plans require plain JSON objects");
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length)
      throw new ExecutionPlanValidationError("JSON symbols are unsupported");
    if (Array.isArray(value)) {
      const result: DurableJSON[] = [];
      for (let index = 0; index < value.length; index++) {
        const entry = descriptors[String(index)];
        if (!entry || !("value" in entry))
          throw new ExecutionPlanValidationError("Sparse/accessor JSON arrays are unsupported");
        result.push(copyJSON(entry.value, maxDepth, depth + 1, active));
      }
      if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))
        throw new ExecutionPlanValidationError("JSON arrays cannot have named properties");
      return result;
    }
    const result: Record<string, DurableJSON> = {};
    for (const [key, entry] of Object.entries(descriptors)) {
      if (unsafeKeys.has(key) || !("value" in entry) || !entry.enumerable)
        throw new ExecutionPlanValidationError("Unsafe JSON key or property descriptor");
      result[key] = copyJSON(entry.value, maxDepth, depth + 1, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}
function canonical(value: DurableJSON): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isJSONObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: DurableJSON): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function sameHostData(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonical(copyJSON(left, 64)) === canonical(copyJSON(right, 64));
}
function sandboxDescriptor(value: unknown): DurableJSON {
  if (value === undefined) return false;
  const copied = copyJSON(value, 64);
  if (isJSONObject(copied) && copied.env !== undefined) {
    if (!isJSONObject(copied.env))
      throw new ExecutionPlanValidationError("Sandbox environment requires plain string values");
    const environment: Record<string, DurableJSON> = {};
    for (const [name, entry] of Object.entries(copied.env)) {
      if (typeof entry !== "string")
        throw new ExecutionPlanValidationError("Sandbox environment requires string values");
      environment[name] = digest(entry);
    }
    copied.env = environment;
  }
  return copied;
}
function pathKey(path: readonly string[]): string {
  for (const segment of path) {
    if (!segment || segment.includes(".") || unsafeKeys.has(segment))
      throw new ExecutionPlanValidationError("Unsafe or ambiguous execution reference path");
    requireIdentity(segment, "execution reference segment");
  }
  return path.join(".");
}
function reference(value: DurableJSON): { node: string; path: string[] } | undefined {
  if (!isJSONObject(value) || !Object.hasOwn(value, "$ref")) return undefined;
  const parsed = referenceSchema.safeParse(value);
  if (!parsed.success)
    throw new ExecutionPlanValidationError("Malformed execution output reference", { cause: parsed.error });
  pathKey(parsed.data.$ref.path);
  return parsed.data.$ref;
}
function references(
  value: DurableJSON,
  path: string[] = [],
): { producer: string; outputPath: string[]; argumentPath: string[] }[] {
  const ref = reference(value);
  if (ref) return [{ producer: ref.node, outputPath: ref.path, argumentPath: path }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => references(entry, [...path, String(index)]));
  if (isJSONObject(value)) return Object.entries(value).flatMap(([key, entry]) => references(entry, [...path, key]));
  return [];
}
function validateReferencePaths(paths: readonly string[] | undefined, label: string): void {
  if (paths === undefined) return;
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length)
    throw new ExecutionPlanValidationError(`${label} must contain unique paths`);
  for (const path of paths) {
    if (typeof path !== "string") throw new ExecutionPlanValidationError(`Invalid ${label}`);
    pathKey(path === "" ? [] : path.split("."));
  }
}
function checkSchema(schema: GraphValueSchema, label: string): void {
  if (!schema || typeof schema.parse !== "function")
    throw new ExecutionPlanValidationError(`Missing ${label} validator`);
}
type CatalogContext = {
  bindings: Map<string, GraphBinding>;
  limits: PlanValidationLimits;
  nested: Map<string, ExecutionPlan>;
  checkedNested: Set<string>;
};

function createCatalog(catalog: readonly GraphBinding[], limits: PlanValidationLimits): CatalogContext {
  positiveInteger(limits.maxBytes, "maxBytes");
  positiveInteger(limits.maxNodes, "maxNodes", true);
  positiveInteger(limits.maxDepth, "maxDepth");
  positiveInteger(limits.maxConcurrency, "maxConcurrency");
  if (typeof limits.durable !== "boolean") throw new ExecutionPlanValidationError("durable must be boolean");
  if (!Array.isArray(catalog)) throw new ExecutionPlanValidationError("Catalog must be an array");
  const bindings = new Map<string, GraphBinding>();
  const toolNames = new Set<string>();
  for (const binding of catalog) {
    requireIdentity(binding.id, "binding ID");
    requireIdentity(binding.version, "binding version");
    if (bindings.has(binding.id)) throw new ExecutionPlanValidationError(`Duplicate binding ${binding.id}`);
    checkSchema(binding.input, "binding input");
    checkSchema(binding.output, "binding output");
    validateReferencePaths(binding.referenceInputs, "referenceInputs");
    validateReferencePaths(binding.referenceOutputs, "referenceOutputs");
    if (binding.validateTemplate !== undefined && typeof binding.validateTemplate !== "function")
      throw new ExecutionPlanValidationError("validateTemplate must be callable");
    switch (binding.kind) {
      case "tool": {
        if (!binding.tool || typeof binding.tool.execute !== "function")
          throw new ExecutionPlanValidationError("Tool binding requires an executable tool");
        if (typeof binding.tool.description !== "string")
          throw new ExecutionPlanValidationError("Tool binding requires a model-visible description");
        if (limits.durable && (binding.tool.cache !== undefined || binding.tool.toModelOutput !== undefined))
          throw new ExecutionPlanValidationError("Durable tools cannot use unrecorded caching or output transforms");
        requireIdentity(binding.tool.name, "tool name");
        if (toolNames.has(binding.tool.name)) throw new ExecutionPlanValidationError("Ambiguous catalog tool name");
        toolNames.add(binding.tool.name);
        if (binding.recovery !== "pure") {
          const recovery = binding.recovery;
          if (!recovery) {
            if (limits.durable)
              throw new ExecutionPlanValidationError(`Unsupported durable recovery for ${binding.id}`);
          } else {
            requireIdentity(recovery.destination, "effect destination");
            requireIdentity(recovery.connector?.version, "connector version");
            if (typeof recovery.connector.dispatch !== "function" || typeof recovery.resolveResult !== "function")
              throw new ExecutionPlanValidationError("Durable effects require a connector and receipt resolver");
          }
        }
        break;
      }
      case "agent":
        if (
          !binding.agent ||
          typeof binding.agent.run !== "function" ||
          !Array.isArray(binding.tools) ||
          new Set(binding.tools).size !== binding.tools.length
        )
          throw new ExecutionPlanValidationError("Agent binding requires an Agent and unique approved tools");
        break;
      case "graph":
        break;
      case "repeat":
        positiveInteger(binding.maxIterations, "maxIterations");
        if (typeof binding.while !== "function")
          throw new ExecutionPlanValidationError("Repeat binding requires a pinned guard");
        break;
      default:
        throw new ExecutionPlanValidationError("Unknown catalog binding kind");
    }
    bindings.set(binding.id, binding);
  }
  const context: CatalogContext = { bindings, limits, nested: new Map(), checkedNested: new Set() };
  for (const binding of bindings.values()) {
    if (binding.kind === "agent") {
      const descriptor = binding.agent.getRecoveryDescriptor();
      if (limits.durable && descriptor.unsupported.length)
        throw new ExecutionPlanValidationError(
          `Unsupported durable Agent configuration: ${descriptor.unsupported.join(", ")}`,
        );
      const approved = new Map<string, GraphBinding>();
      for (const id of binding.tools) {
        const tool = bindings.get(id);
        if (tool?.kind !== "tool")
          throw new ExecutionPlanValidationError(`Agent approved tool ${id} is not a catalog tool binding`);
        approved.set(tool.tool.name, tool);
      }
      if (descriptor.toolNames.some((name) => !approved.has(name)))
        throw new ExecutionPlanValidationError("Agent recovery descriptor includes an unapproved tool");
      for (const local of binding.agent.tools) {
        const approvedBinding = approved.get(local.name);
        if (
          approvedBinding?.kind !== "tool" ||
          approvedBinding.tool.execute !== local.execute ||
          approvedBinding.tool.parameters !== local.parameters ||
          approvedBinding.tool.requiresApproval !== local.requiresApproval ||
          !sameHostData(approvedBinding.tool.sandbox, local.sandbox) ||
          !sameHostData(approvedBinding.tool.rawJsonSchema, local.rawJsonSchema) ||
          !sameHostData(approvedBinding.tool.inputExamples, local.inputExamples) ||
          approvedBinding.tool.strict !== local.strict ||
          approvedBinding.tool.description !== local.description ||
          approvedBinding.tool.toModelOutput !== local.toModelOutput
        )
          throw new ExecutionPlanValidationError(
            `Agent-local tool ${local.name} is not an approved executable binding`,
          );
      }
    }
    validateNested(binding, context, new Set(), 1);
  }
  return context;
}
function validateProgram(
  program: ExecutionGraphProgram,
  context: CatalogContext,
  active: Set<string>,
  depth: number,
): ExecutionPlan | undefined {
  if (!program || typeof program !== "object") throw new ExecutionPlanValidationError("Missing nested program");
  requireIdentity(program.id, "program ID");
  requireIdentity(program.version, "program version");
  if ((program.plan !== undefined) === (program.planner !== undefined))
    throw new ExecutionPlanValidationError("Program requires exactly one plan or planner");
  if (program.plan) return validatePlan(program.plan, context, active, depth).plan;
  const planner = program.planner;
  if (
    !planner?.provider ||
    typeof planner.provider.generate !== "function" ||
    typeof planner.provider.stream !== "function"
  )
    throw new ExecutionPlanValidationError("Planner requires a provider binding");
  requireIdentity(planner.provider.providerId, "planner provider ID");
  requireIdentity(planner.provider.modelId, "planner model ID");
  if (typeof planner.hostInstructions !== "string" || !planner.hostInstructions.trim())
    throw new ExecutionPlanValidationError("Planner requires host instructions");
  positiveInteger(planner.maxCorrections, "maxCorrections", true);
  positiveInteger(planner.maxOutputTokens, "maxOutputTokens");
  if (planner.mode !== undefined && planner.mode !== "complete" && planner.mode !== "stream")
    throw new ExecutionPlanValidationError("Unknown planner mode");
  if (!planner.stream) throw new ExecutionPlanValidationError("Planner requires stream bounds");
  for (const [key, value] of Object.entries(planner.stream)) positiveInteger(value, key);
  for (const key of ["maxFrameBytes", "maxTotalBytes", "maxFrames"] as const) positiveInteger(planner.stream[key], key);
  return undefined;
}
function validateNested(binding: GraphBinding, context: CatalogContext, active: Set<string>, depth: number): void {
  if (binding.kind !== "graph" && binding.kind !== "repeat") return;
  if (depth > context.limits.maxDepth) throw new ExecutionPlanValidationError("Nested binding depth exhausted");
  if (active.has(binding.id)) throw new ExecutionPlanValidationError("Recursive execution catalog program");
  const checkedKey = JSON.stringify([binding.id, depth]);
  if (context.checkedNested.has(checkedKey)) return;
  active.add(binding.id);
  try {
    const plan = validateProgram(binding.program, context, active, depth + 1);
    if (plan) context.nested.set(binding.id, plan);
    context.checkedNested.add(checkedKey);
  } finally {
    active.delete(binding.id);
  }
}
function readPlan(value: unknown, limits: PlanValidationLimits): ExecutionPlan {
  positiveInteger(limits.maxDepth, "maxDepth");
  positiveInteger(limits.maxBytes, "maxBytes");
  const json = copyJSON(value, limits.maxDepth);
  if (Buffer.byteLength(canonical(json)) > limits.maxBytes)
    throw new ExecutionPlanValidationError("Execution proposal byte limit exceeded");
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) throw new ExecutionPlanValidationError("Invalid execution proposal", { cause: parsed.error });
  return parsed.data;
}
function validatePlan(
  value: unknown,
  context: CatalogContext,
  active = new Set<string>(),
  depth = 1,
): Omit<ValidatedExecutionPlan, "catalogDigest"> {
  const plan = readPlan(value, context.limits);
  if (plan.nodes.length > context.limits.maxNodes)
    throw new ExecutionPlanValidationError("Execution node limit exceeded");
  if ((plan.maxConcurrency ?? context.limits.maxConcurrency) > context.limits.maxConcurrency)
    throw new ExecutionPlanValidationError("Execution concurrency exceeds host limit");
  const byId = new Map<string, ExecutionPlanNode>();
  for (const node of plan.nodes) {
    if (byId.has(node.id)) throw new ExecutionPlanValidationError(`Duplicate node ${node.id}`);
    const binding = context.bindings.get(node.binding);
    if (!binding || binding.version !== node.version)
      throw new ExecutionPlanValidationError(`Missing or changed binding ${node.binding}`);
    validateNested(binding, context, active, depth);
    byId.set(node.id, node);
  }
  const requirements: PlanReferenceRequirement[] = [];
  const dependencies = new Map<string, string[]>();
  for (const node of plan.nodes) {
    const binding = context.bindings.get(node.binding);
    if (!binding) throw new ExecutionPlanValidationError("Missing validated binding");
    for (const edges of [node.dependsOn, node.inputsFrom])
      if (edges && new Set(edges).size !== edges.length) throw new ExecutionPlanValidationError("Duplicate dependency");
    const refs = references(node.args);
    if (refs.length) {
      if (!binding.validateTemplate)
        throw new ExecutionPlanValidationError("Future values require host template validation");
      for (const ref of refs) {
        const producer = byId.get(ref.producer);
        const producerBinding = producer && context.bindings.get(producer.binding);
        if (!producerBinding) throw new ExecutionPlanValidationError(`Missing reference producer ${ref.producer}`);
        if (
          !binding.referenceInputs?.includes(pathKey(ref.argumentPath)) ||
          !producerBinding.referenceOutputs?.includes(pathKey(ref.outputPath))
        )
          throw new ExecutionPlanValidationError("Reference input/output path is not approved by the catalog");
        requirements.push({ consumer: node.id, ...ref });
      }
      const template = copyJSON(node.args, context.limits.maxDepth);
      if (!isJSONObject(template)) throw new ExecutionPlanValidationError("Arguments must be objects");
      const before = digest(template);
      try {
        binding.validateTemplate(template);
      } catch (cause) {
        throw new ExecutionPlanValidationError("Host template validation failed", { cause });
      }
      if (digest(copyJSON(template, context.limits.maxDepth)) !== before)
        throw new ExecutionPlanValidationError("Host template validator mutated reviewed arguments");
    } else {
      try {
        copyJSON(binding.input.parse(copyJSON(node.args, context.limits.maxDepth)), context.limits.maxDepth);
      } catch (cause) {
        throw new ExecutionPlanValidationError("Invalid binding input", { cause });
      }
    }
    const inferred = refs.map((ref) => ref.producer);
    if (inferred.length) node.inputsFrom = [...new Set([...(node.inputsFrom ?? []), ...inferred])];
    dependencies.set(node.id, [...new Set([...(node.dependsOn ?? []), ...(node.inputsFrom ?? [])])]);
  }
  const order: string[] = [];
  const complete = new Set<string>();
  const dependencyDepth = new Map<string, number>();
  for (const [id, parents] of dependencies)
    for (const parent of parents)
      if (parent === id || !byId.has(parent)) throw new ExecutionPlanValidationError("Missing or self dependency");
  while (order.length < plan.nodes.length) {
    const next = plan.nodes.find(
      (node) => !complete.has(node.id) && dependencies.get(node.id)?.every((id) => complete.has(id)),
    );
    if (!next) throw new ExecutionPlanValidationError("Execution dependency cycle");
    const level = 1 + Math.max(0, ...(dependencies.get(next.id) ?? []).map((id) => dependencyDepth.get(id) ?? 0));
    if (depth + level - 1 > context.limits.maxDepth)
      throw new ExecutionPlanValidationError("Execution dependency depth exhausted");
    dependencyDepth.set(next.id, level);
    const binding = context.bindings.get(next.binding);
    if (binding) validateNested(binding, context, active, depth + level - 1);
    order.push(next.id);
    complete.add(next.id);
  }
  return {
    plan,
    order,
    referenceRequirements: requirements,
    digest: digest(copyJSON(plan, context.limits.maxDepth)),
    bindingKinds: Object.fromEntries([...context.bindings].map(([id, binding]) => [id, binding.kind])),
  };
}
function isAgentiumSchema(schema: GraphValueSchema): schema is AgentiumSchema & GraphValueSchema {
  return "_zod" in schema || "_def" in schema;
}
function convertedSchemaDescriptor(schema: AgentiumSchema): DurableJSON {
  // The trusted converter can attach nonenumerable runtime annotations (Zod4's
  // ~standard). Persist only the JSON representation, then apply the same strict
  // finite-JSON checks used for durable catalog descriptors.
  return copyJSON(JSON.parse(JSON.stringify(convertJsonSchema(schema).schema)), 64);
}
function schemaDescriptor(schema: GraphValueSchema): DurableJSON {
  return isAgentiumSchema(schema) ? convertedSchemaDescriptor(schema) : { opaque: true };
}
function describeCatalog(context: CatalogContext): DurableJSON[] {
  return [...context.bindings.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((binding) => {
      const base = {
        id: binding.id,
        version: binding.version,
        kind: binding.kind,
        input: schemaDescriptor(binding.input),
        output: schemaDescriptor(binding.output),
        referenceInputs: [...(binding.referenceInputs ?? [])].sort(),
        referenceOutputs: [...(binding.referenceOutputs ?? [])].sort(),
        templateValidation: Boolean(binding.validateTemplate),
      };
      if (binding.kind === "tool")
        return {
          ...base,
          tool: {
            name: binding.tool.name,
            description: binding.tool.description,
            parameters: convertedSchemaDescriptor(binding.tool.parameters),
            strict: binding.tool.strict ?? null,
            ...(binding.tool.rawJsonSchema !== undefined
              ? { rawJsonSchema: copyJSON(binding.tool.rawJsonSchema, 64) }
              : {}),
            ...(binding.tool.inputExamples !== undefined
              ? { inputExamples: copyJSON(binding.tool.inputExamples, 64) }
              : {}),
            approval:
              typeof binding.tool.requiresApproval === "boolean"
                ? binding.tool.requiresApproval
                : binding.tool.requiresApproval
                  ? "host"
                  : false,
            sandbox: sandboxDescriptor(binding.tool.sandbox),
            transform: Boolean(binding.tool.toModelOutput),
          },
          recovery:
            binding.recovery === "pure"
              ? "pure"
              : binding.recovery
                ? { connectorVersion: binding.recovery.connector.version, destination: binding.recovery.destination }
                : null,
        };
      if (binding.kind === "agent") return { ...base, tools: [...binding.tools].sort(), agentName: binding.agent.name };
      const program = binding.program;
      const planner = program.planner;
      return {
        ...base,
        program: {
          id: program.id,
          version: program.version,
          ...(program.plan ? { plan: copyJSON(context.nested.get(binding.id), context.limits.maxDepth) } : {}),
          ...(planner
            ? {
                planner: {
                  provider: planner.provider.providerId,
                  model: planner.provider.modelId,
                  hostInstructions: planner.hostInstructions,
                  maxCorrections: planner.maxCorrections,
                  maxOutputTokens: planner.maxOutputTokens,
                  mode: planner.mode ?? "complete",
                  stream: copyJSON(planner.stream, context.limits.maxDepth),
                },
              }
            : {}),
        },
        ...(binding.kind === "repeat" ? { maxIterations: binding.maxIterations } : {}),
      };
    });
}

/** Validate and copy a complete proposal without invoking models, effects, policy or guards. */
export function validateExecutionPlan(
  value: unknown,
  catalog: readonly GraphBinding[],
  limits: PlanValidationLimits,
  initialDepth = 1,
): ValidatedExecutionPlan {
  try {
    positiveInteger(initialDepth, "initialDepth");
    positiveInteger(limits.maxDepth, "maxDepth");
    if (initialDepth > limits.maxDepth) throw new ExecutionPlanValidationError("Inherited execution depth exhausted");
    const plan = readPlan(value, limits);
    const context = createCatalog(catalog, limits);
    return { ...validatePlan(plan, context, new Set(), initialDepth), catalogDigest: digest(describeCatalog(context)) };
  } catch (cause) {
    if (cause instanceof ExecutionPlanValidationError) throw cause;
    throw new ExecutionPlanValidationError("Invalid execution catalog or proposal", { cause });
  }
}
/** Serializable catalog identity excludes executable code and credentials; hosts version opaque behavior. */
export function graphCatalogDescriptor(catalog: readonly GraphBinding[], limits: PlanValidationLimits): DurableJSON[] {
  try {
    return describeCatalog(createCatalog(catalog, limits));
  } catch (cause) {
    if (cause instanceof ExecutionPlanValidationError) throw cause;
    throw new ExecutionPlanValidationError("Invalid execution catalog", { cause });
  }
}
export function graphCatalogDigest(catalog: readonly GraphBinding[], limits: PlanValidationLimits): string {
  return digest(graphCatalogDescriptor(catalog, limits));
}

/** Resolve own JSON output properties; caller validates concrete args before effect admission. */
export function resolvePlanArguments(
  node: ExecutionPlanNode,
  outputs: ReadonlyMap<string, DurableJSON>,
  maxDepth = 64,
): Record<string, DurableJSON> {
  positiveInteger(maxDepth, "reference maxDepth");
  const resolve = (value: DurableJSON): DurableJSON => {
    const ref = reference(value);
    if (ref) {
      const output = outputs.get(ref.node);
      if (output === undefined) throw new ExecutionPlanValidationError(`Output ${ref.node} is unavailable`);
      let selected: DurableJSON = copyJSON(output, maxDepth);
      for (const segment of ref.path) {
        if (Array.isArray(selected)) {
          if (!/^(0|[1-9]\d*)$/.test(segment) || !Object.hasOwn(selected, segment))
            throw new ExecutionPlanValidationError("Unavailable output array path");
          selected = selected[Number(segment)];
        } else if (isJSONObject(selected) && Object.hasOwn(selected, segment)) selected = selected[segment];
        else throw new ExecutionPlanValidationError("Unavailable output reference path");
      }
      return copyJSON(selected, maxDepth);
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (isJSONObject(value))
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    return value;
  };
  const args = resolve(copyJSON(node.args, maxDepth));
  if (!isJSONObject(args)) throw new ExecutionPlanValidationError("Resolved arguments must be an object");
  return args;
}
