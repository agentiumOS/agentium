import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { RunContext } from "@agentium/core";
import { sortHarnessMiddleware } from "./middleware.js";
import {
  type HarnessRuntimeReferences,
  type HarnessRuntimeRegistry,
  resolveHarnessRuntime,
} from "./runtime-registry.js";
import type {
  AbilityDescription,
  AbilityFactory,
  AbilitySelection,
  BoundHarness,
  HarnessDefaults,
  HarnessDefinition,
  HarnessDefinitionInput,
  HarnessDescription,
  HarnessDiagnostic,
  HarnessExtension,
  HarnessManifest,
  HarnessProvenance,
  JsonObject,
  JsonValue,
  LocalAbilityUse,
  ResolvedHarness,
} from "./types.js";

export class HarnessValidationError extends Error {
  readonly diagnostics: readonly HarnessDiagnostic[];
  constructor(path: string, message: string, code = "invalid_harness") {
    super(`${path}: ${message}`);
    this.name = "HarnessValidationError";
    this.diagnostics = [{ code, path, message, severity: "error" }];
  }
}
const generatedIds = new WeakSet<object>();
const definitions = new WeakSet<object>();
const metadata = new WeakMap<object, { provenance: HarnessProvenance[]; diagnostics: HarnessDiagnostic[] }>();
const secretKeys = new Set([
  "apikey",
  "password",
  "secret",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "privatekey",
  "credentials",
]);
function fail(path: string, message: string): never {
  throw new HarnessValidationError(path, message);
}
function object(input: unknown, path: string): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail(path, "expected a plain object");
  return input as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field");
}
function id(input: unknown, path: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(input))
    fail(path, "expected a stable nonempty identifier");
  return input;
}
function integer(input: unknown, path: string, min = 0): number {
  if (typeof input !== "number" || !Number.isFinite(input) || !Number.isInteger(input) || input < min)
    fail(path, `expected an integer >= ${min}`);
  return input;
}
function json(input: unknown, path: string, seen = new Set<object>()): JsonValue {
  if (input === null || typeof input === "boolean" || typeof input === "string") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "object" || input === null) fail(path, "expected JSON data");
  if (seen.has(input)) fail(path, "cyclic data is not portable");
  seen.add(input);
  try {
    if (Array.isArray(input)) {
      if (
        Object.getOwnPropertySymbols(input).length ||
        Object.keys(input).some((key) => !/^(0|[1-9][0-9]*)$/.test(key))
      )
        fail(path, "array properties are not portable");
      return Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (!descriptor || !("value" in descriptor))
          fail(`${path}[${index}]`, "sparse arrays and accessors are not portable");
        return json(descriptor.value, `${path}[${index}]`, seen);
      });
    }
    const source = object(input, path);
    if (Object.getOwnPropertySymbols(source).length) fail(path, "symbol properties are not portable");
    const result: JsonObject = {};
    for (const key of Object.keys(source)) {
      if (secretKeys.has(key.replace(/[_-]/g, "").toLowerCase()))
        fail(`${path}.${key}`, "credentials belong in host bindings");
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if (!("value" in descriptor)) fail(`${path}.${key}`, "accessors are not portable");
      Object.defineProperty(result, key, {
        value: json(descriptor.value, `${path}.${key}`, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    seen.delete(input);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validateDefaults(input: unknown, path = "defaults"): HarnessDefaults {
  const data = object(json(input, path), path);
  keys(
    data,
    ["workspace", "skillDirs", "contextFiles", "filesystem", "subagents", "fileMemory", "searchPastSessions"],
    path,
  );
  for (const [key, value] of Object.entries(data)) {
    if (key === "workspace") {
      if (value === false) continue;
      const workspace = object(value, `${path}.workspace`);
      keys(workspace, ["path", "mode"], `${path}.workspace`);
      if (
        typeof workspace.path !== "string" ||
        !workspace.path.length ||
        !["read", "write"].includes(workspace.mode as string)
      )
        fail(`${path}.workspace`, "expected a path and read/write mode");
    } else if (key === "skillDirs") {
      if (value !== false && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.length)))
        fail(`${path}.skillDirs`, "expected a list of paths or false");
    } else if (typeof value !== "boolean") fail(`${path}.${key}`, "expected a boolean");
  }
  return data as HarnessDefaults;
}
function validateLimits(input: unknown, path = "limits"): NonNullable<HarnessManifest["limits"]> {
  const data = object(json(input, path), path);
  keys(data, ["toolRoundtrips", "maxChildDepth"], path);
  for (const [key, value] of Object.entries(data)) integer(value, `${path}.${key}`);
  return data;
}
function validateSelection(input: unknown, path: string): AbilitySelection {
  const data = object(input, path);
  keys(data, ["instanceId", "type", "version", "options"], path);
  return {
    instanceId: id(data.instanceId, `${path}.instanceId`),
    type: id(data.type, `${path}.type`),
    version: integer(data.version, `${path}.version`, 1),
    options: object(json(data.options, `${path}.options`), `${path}.options`) as JsonObject,
  };
}
function validateRuntimeReferences(input: unknown, path = "runtime"): HarnessRuntimeReferences {
  const data = object(json(input, path), path);
  keys(data, ["driver", "controller", "contextPolicy", "completionPolicy", "modelRoles"], path);
  for (const [key, value] of Object.entries(data)) {
    const item = object(value, `${path}.${key}`);
    if (key === "modelRoles") {
      for (const [role, name] of Object.entries(item)) {
        id(role, `${path}.modelRoles`);
        id(name, `${path}.modelRoles.${role}`);
      }
    } else {
      keys(item, ["id", "version"], `${path}.${key}`);
      id(item.id, `${path}.${key}.id`);
      integer(item.version, `${path}.${key}.version`, 1);
    }
  }
  return freeze(data as HarnessRuntimeReferences);
}
export function validateHarnessManifest(input: unknown): HarnessManifest {
  const data = object(json(input, "manifest"), "manifest");
  keys(data, ["contractVersion", "id", "abilities", "defaults", "limits", "runtime"], "manifest");
  if (data.contractVersion !== 1) fail("manifest.contractVersion", "unsupported contract version");
  if (!Array.isArray(data.abilities)) fail("manifest.abilities", "expected an array");
  const abilities = data.abilities.map((ability, index) => validateSelection(ability, `manifest.abilities[${index}]`));
  unique(
    abilities.map((ability) => ability.instanceId),
    "manifest.abilities",
  );
  return freeze({
    contractVersion: 1,
    id: id(data.id, "manifest.id"),
    abilities,
    ...(data.runtime !== undefined ? { runtime: validateRuntimeReferences(data.runtime) } : {}),
    ...(data.defaults !== undefined ? { defaults: validateDefaults(data.defaults) } : {}),
    ...(data.limits !== undefined ? { limits: validateLimits(data.limits) } : {}),
  });
}
function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "duplicate identifiers");
}
function registry(factories: readonly AbilityFactory[]): Map<string, AbilityFactory> {
  if (!Array.isArray(factories)) fail("factories", "expected an approved factory registry");
  const map = new Map<string, AbilityFactory>();
  for (const factory of factories) {
    if (!factory || typeof factory !== "object") fail("factory", "expected a trusted factory");
    id(factory.type, "factory.type");
    integer(factory.version, "factory.version", 1);
    if (
      typeof factory.validateOptions !== "function" ||
      typeof factory.describe !== "function" ||
      typeof factory.bind !== "function"
    )
      fail("factory", "missing validation, description or binding function");
    const key = `${factory.type}@${factory.version}`;
    if (map.has(key) && map.get(key) !== factory)
      fail("factories", "conflicting implementations for a registered type/version");
    map.set(key, factory);
  }
  return map;
}
function snapshotRuntimeRegistry(input: HarnessRuntimeRegistry): HarnessRuntimeRegistry {
  keys(
    object(input, "runtimeRegistry"),
    ["driver", "controller", "contextPolicy", "completionPolicy"],
    "runtimeRegistry",
  );
  const result: Record<string, unknown> = {};
  for (const [key, entries] of Object.entries(input)) {
    if (!Array.isArray(entries)) fail(`runtimeRegistry.${key}`, "expected approved registry entries");
    const names: string[] = [];
    result[key] = Object.freeze(
      entries.map((entry) => {
        id(entry.id, `runtimeRegistry.${key}.id`);
        integer(entry.version, `runtimeRegistry.${key}.version`, 1);
        names.push(`${entry.id}@${entry.version}`);
        if (!entry.implementation || typeof entry.implementation !== "object")
          fail(`runtimeRegistry.${key}`, "missing trusted implementation");
        return Object.freeze({ ...entry });
      }),
    );
    unique(names, `runtimeRegistry.${key}`);
  }
  return Object.freeze(result);
}
function normalizePortable(
  manifest: HarnessManifest,
  factories: readonly AbilityFactory[],
  runtimeRegistry?: HarnessRuntimeRegistry,
): HarnessDefinition {
  const approved = registry(factories);
  const abilities = manifest.abilities.map((selection, index) => {
    const factory = approved.get(`${selection.type}@${selection.version}`);
    if (!factory) fail(`manifest.abilities[${index}]`, "no approved factory for ability type/version");
    let options: JsonObject;
    try {
      options = factory.validateOptions(json(selection.options, "options") as JsonObject);
    } catch {
      fail(`manifest.abilities[${index}].options`, "ability option validation failed");
    }
    return {
      ...selection,
      options: object(json(options, `manifest.abilities[${index}].options`), "options") as JsonObject,
    };
  });
  const definition = Object.freeze({
    kind: "portable" as const,
    manifest: validateHarnessManifest({ ...manifest, abilities }),
    factories: Object.freeze([...approved.values()]),
    ...(runtimeRegistry ? { runtimeRegistry: snapshotRuntimeRegistry(runtimeRegistry) } : {}),
  });
  resolveHarnessRuntime(definition);
  definitions.add(definition);
  return definition;
}
export function loadHarnessManifest(
  input: unknown,
  factories: readonly AbilityFactory[],
  runtimeRegistry?: HarnessRuntimeRegistry,
): HarnessDefinition {
  return normalizePortable(validateHarnessManifest(input), factories, runtimeRegistry);
}
export function createHarnessDefinition(input: HarnessDefinitionInput): HarnessDefinition {
  object(input, "definition");
  if (definitions.has(input)) return input as HarnessDefinition;
  if ("kind" in input && input.kind === "portable") {
    keys(object(input, "definition"), ["kind", "manifest", "factories", "runtimeRegistry"], "definition");
    return loadHarnessManifest(input.manifest, input.factories, input.runtimeRegistry);
  }
  const local = input as Exclude<HarnessDefinition, { kind: "portable" }>;
  keys(
    object(input, "definition"),
    ["kind", "id", "abilities", "defaults", "limits", "runtime", "runtimeReferences", "runtimeRegistry"],
    "definition",
  );
  if ("kind" in input && input.kind !== "local") fail("definition.kind", "unsupported definition kind");
  if (local.abilities !== undefined && !Array.isArray(local.abilities)) fail("abilities", "expected an ability list");
  const abilities = [...(local.abilities ?? [])].map((use, index) => {
    if (!use || typeof use !== "object") fail(`abilities[${index}]`, "expected an ability use");
    id(use.instanceId, `abilities[${index}].instanceId`);
    if (typeof use.validate !== "function" || typeof use.describe !== "function" || typeof use.bind !== "function")
      fail(`abilities[${index}]`, "missing validation, description or binding function");
    try {
      use.validate();
    } catch {
      fail(`abilities[${index}]`, "ability option validation failed");
    }
    const portable = use.portable
      ? freeze(validateSelection(json(use.portable, `abilities[${index}].portable`), `abilities[${index}].portable`))
      : undefined;
    if (portable && portable.instanceId !== use.instanceId)
      fail(`abilities[${index}].portable.instanceId`, "portable and local IDs must match");
    if (portable && use.factory && (portable.type !== use.factory.type || portable.version !== use.factory.version))
      fail(`abilities[${index}].factory`, "factory mapping does not match selection");
    return Object.freeze({ ...use, ...(portable ? { portable } : {}) });
  });
  unique(
    abilities.map((use) => use.instanceId),
    "abilities",
  );
  registry(abilities.flatMap((use) => (use.factory ? [use.factory] : [])));
  const definition: HarnessDefinition = Object.freeze({
    kind: "local",
    id: local.id === undefined ? `local-${randomUUID()}` : id(local.id, "definition.id"),
    abilities: Object.freeze(abilities),
    ...(local.runtime ? { runtime: Object.freeze({ ...local.runtime }) } : {}),
    ...(local.runtimeReferences ? { runtimeReferences: validateRuntimeReferences(local.runtimeReferences) } : {}),
    ...(local.runtimeRegistry ? { runtimeRegistry: snapshotRuntimeRegistry(local.runtimeRegistry) } : {}),
    ...(local.defaults !== undefined ? { defaults: freeze(validateDefaults(local.defaults)) } : {}),
    ...(local.limits !== undefined ? { limits: freeze(validateLimits(local.limits)) } : {}),
  });
  resolveHarnessRuntime(definition);
  definitions.add(definition);
  if (local.id === undefined || generatedIds.has(input)) generatedIds.add(definition);
  metadata.set(
    definition,
    metadata.get(input) ?? {
      provenance: [
        ...Object.keys(local.defaults ?? {}).map((key) => ({ path: `defaults.${key}`, origin: definition.id! })),
        ...Object.keys(local.limits ?? {}).map((key) => ({ path: `limits.${key}`, origin: definition.id! })),
        ...abilities.map((use) => ({ path: `abilities.${use.instanceId}`, origin: definition.id! })),
      ],
      diagnostics: [],
    },
  );
  return definition;
}
function asLocal(definition: HarnessDefinition): Exclude<HarnessDefinition, { kind: "portable" }> {
  if (definition.kind === "local") return definition;
  const approved = registry(definition.factories);
  return {
    kind: "local",
    id: definition.manifest.id,
    defaults: definition.manifest.defaults,
    limits: definition.manifest.limits,
    runtimeReferences: definition.manifest.runtime,
    runtimeRegistry: definition.runtimeRegistry,
    abilities: definition.manifest.abilities.map((selection) => {
      const factory = approved.get(`${selection.type}@${selection.version}`)!;
      return {
        instanceId: selection.instanceId,
        portable: selection,
        factory,
        validate: () => {},
        describe: () => factory.describe(selection.options),
        bind: (ctx) => factory.bind(selection.options, ctx),
      };
    }),
  };
}
export function extendHarnessDefinition(base: HarnessDefinition, extension: HarnessExtension): HarnessDefinition {
  keys(
    object(extension, "extension"),
    [
      "id",
      "abilities",
      "disable",
      "replaceAbilities",
      "defaults",
      "limits",
      "runtime",
      "runtimeReferences",
      "runtimeRegistry",
    ],
    "extension",
  );
  const source = asLocal(createHarnessDefinition(base));
  const disabled = new Set(extension.disable ?? []);
  unique([...(extension.disable ?? [])], "extension.disable");
  for (const target of disabled)
    if (!source.abilities.some((use) => use.instanceId === target))
      fail("extension.disable", "unknown ability identifier");
  const replacements = new Map((extension.replaceAbilities ?? []).map((use) => [use.instanceId, use]));
  unique([...(extension.replaceAbilities ?? []).map((use) => use.instanceId)], "extension.replaceAbilities");
  for (const target of replacements.keys())
    if (disabled.has(target) || !source.abilities.some((use) => use.instanceId === target))
      fail("extension.replaceAbilities", "replacement must match an enabled existing ability");
  const defaults = { ...source.defaults, ...(extension.defaults ? validateDefaults(extension.defaults) : {}) };
  if (extension.defaults?.skillDirs && source.defaults?.skillDirs)
    defaults.skillDirs = [...new Set([...source.defaults.skillDirs, ...extension.defaults.skillDirs])];
  const definition = createHarnessDefinition({
    id: extension.id ?? source.id,
    runtime: { ...source.runtime, ...extension.runtime },
    runtimeReferences: extension.runtimeReferences ?? source.runtimeReferences,
    runtimeRegistry: extension.runtimeRegistry ?? source.runtimeRegistry,
    abilities: [
      ...source.abilities
        .filter((use) => !disabled.has(use.instanceId))
        .map((use) => replacements.get(use.instanceId) ?? use),
      ...(extension.abilities ?? []),
    ],
    defaults,
    limits: { ...source.limits, ...(extension.limits ? validateLimits(extension.limits) : {}) },
  });
  if (generatedIds.has(base) && !extension.id) generatedIds.add(definition);
  const previous = metadata.get(base);
  const origin = extension.id ?? source.id ?? "local";
  metadata.set(definition, {
    provenance: [
      ...(previous?.provenance ?? []),
      ...Object.keys(extension.defaults ?? {}).map((key) => ({ path: `defaults.${key}`, origin })),
      ...Object.keys(extension.limits ?? {}).map((key) => ({ path: `limits.${key}`, origin })),
    ],
    diagnostics: [
      ...(previous?.diagnostics ?? []),
      ...[...disabled].map((instanceId) => ({
        code: "ability_disabled",
        path: `abilities.${instanceId}`,
        message: "Ability explicitly disabled",
        severity: "info" as const,
      })),
    ],
  });
  return definition;
}
function abilityDescription(input: AbilityDescription, path: string): AbilityDescription {
  if (!input || !Array.isArray(input.toolNames) || !Array.isArray(input.requirements))
    fail(path, "expected tool and requirement declarations");
  for (const name of input.toolNames) id(name, `${path}.toolNames`);
  for (const requirement of input.requirements) id(requirement, `${path}.requirements`);
  unique(input.toolNames, `${path}.toolNames`);
  if (input.runtimeDependent !== undefined && typeof input.runtimeDependent !== "boolean")
    fail(path, "invalid runtimeDependent declaration");
  return {
    toolNames: [...input.toolNames],
    requirements: [...new Set(input.requirements)],
    ...(input.runtimeDependent !== undefined ? { runtimeDependent: input.runtimeDependent } : {}),
  };
}
export function describeHarnessDefinition(input: HarnessDefinition): HarnessDescription {
  const definition = createHarnessDefinition(input);
  const local = asLocal(definition);
  const abilities = local.abilities.map((use, index) => {
    let description: AbilityDescription;
    try {
      description = use.describe();
    } catch {
      fail(`abilities[${index}]`, "ability description failed");
    }
    return {
      instanceId: use.instanceId,
      ...(use.portable ? { type: use.portable.type, version: use.portable.version } : {}),
      ...abilityDescription(description, `abilities[${index}]`),
    };
  });
  return freeze({
    id: local.id!,
    kind: definition.kind,
    contractVersion: 1,
    abilities,
    toolNames: abilities.flatMap((ability) => [...ability.toolNames]),
    requirements: [...new Set(abilities.flatMap((ability) => [...ability.requirements]))],
    runtimeDependent: abilities.some((ability) => ability.runtimeDependent),
    defaults: local.defaults ?? {},
    limits: local.limits ?? {},
    diagnostics: metadata.get(input)?.diagnostics ?? [],
  });
}
export function resolveHarness(
  input: HarnessDefinition,
  options: { projectRoot: string; requirements?: readonly string[] },
): ResolvedHarness {
  if (typeof options.projectRoot !== "string" || !isAbsolute(options.projectRoot))
    fail("projectRoot", "an absolute host project root is required");
  const definition = createHarnessDefinition(input);
  const description = describeHarnessDefinition(definition);
  const provided = new Set(options.requirements ?? []);
  for (const requirement of description.requirements)
    if (!provided.has(requirement)) fail(`requirements.${requirement}`, "missing host-provided requirement");
  const defaults = { ...description.defaults };
  if (defaults.workspace)
    defaults.workspace =
      typeof defaults.workspace === "string"
        ? { path: resolve(options.projectRoot, defaults.workspace), mode: "read" }
        : { ...defaults.workspace, path: resolve(options.projectRoot, defaults.workspace.path) };
  if (defaults.skillDirs)
    defaults.skillDirs = [...new Set(defaults.skillDirs.map((path) => resolve(options.projectRoot, path)))];
  const provenance = metadata.get(input)?.provenance ?? [
    ...Object.keys(defaults).map((key) => ({ path: `defaults.${key}`, origin: description.id })),
    ...Object.keys(description.limits).map((key) => ({ path: `limits.${key}`, origin: description.id })),
    ...description.abilities.map((ability) => ({ path: `abilities.${ability.instanceId}`, origin: description.id })),
  ];
  return Object.freeze({
    definition,
    defaults: freeze(defaults),
    limits: description.limits,
    description,
    provenance: freeze([...provenance]),
  });
}
export function exportHarnessManifest(input: HarnessDefinition): HarnessManifest {
  const definition = createHarnessDefinition(input);
  if (definition.kind === "portable") return definition.manifest;
  if (generatedIds.has(input) || generatedIds.has(definition))
    fail("definition.id", "an explicit stable ID is required for export");
  for (const key of ["driver", "controller", "contextPolicy", "completionPolicy"] as const) {
    if (definition.runtime?.[key] && !definition.runtimeReferences?.[key])
      fail(`runtime.${key}`, "approved registry reference required for export");
  }
  resolveHarnessRuntime(definition);
  const abilities = definition.abilities.map((use, index) => {
    if (!use.portable || !use.factory)
      fail(`abilities[${index}]`, "portable selection and approved factory mapping required for export");
    return use.portable;
  });
  const portable = normalizePortable(
    validateHarnessManifest({
      contractVersion: 1,
      id: definition.id,
      abilities,
      ...(definition.runtimeReferences || definition.runtime?.modelRoles
        ? {
            runtime: {
              ...definition.runtimeReferences,
              ...(definition.runtime?.modelRoles ? { modelRoles: definition.runtime.modelRoles } : {}),
            },
          }
        : {}),
      ...(definition.defaults !== undefined ? { defaults: definition.defaults } : {}),
      ...(definition.limits !== undefined ? { limits: definition.limits } : {}),
    }),
    definition.abilities.map((use) => use.factory!),
    definition.runtimeRegistry,
  );
  return (portable as Extract<HarnessDefinition, { kind: "portable" }>).manifest;
}
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hashHarnessManifest(input: HarnessManifest): string {
  return createHash("sha256")
    .update(canonical(validateHarnessManifest(input) as unknown as JsonValue), "utf8")
    .digest("hex");
}
export async function bindHarness(resolved: ResolvedHarness, ctx: RunContext): Promise<BoundHarness> {
  const local = asLocal(resolved.definition);
  const bindings: Awaited<ReturnType<LocalAbilityUse["bind"]>>[] = [];
  const diagnostics: HarnessDiagnostic[] = [];
  let disposing: Promise<readonly HarnessDiagnostic[]> | undefined;
  const dispose = () =>
    (disposing ??= (async () => {
      for (let index = bindings.length - 1; index >= 0; index--) {
        try {
          await bindings[index].dispose?.();
        } catch {
          diagnostics.push({
            code: "cleanup_failed",
            path: `abilities[${index}]`,
            message: "Ability cleanup failed",
            severity: "warning",
          });
        }
      }
      return freeze([...diagnostics]);
    })());
  try {
    for (const [index, ability] of local.abilities.entries()) {
      if (ctx.signal?.aborted) fail(`abilities[${index}]`, "run cancelled before binding");
      const binding = await ability.bind(ctx);
      if (binding && typeof binding === "object") bindings.push(binding);
      if (!binding || !Array.isArray(binding.tools)) fail(`abilities[${index}]`, "binding must contain tools");
      if (ctx.signal?.aborted) fail(`abilities[${index}]`, "run cancelled during binding");
    }
    const tools = bindings.flatMap((binding) => [...binding.tools]);
    const promptFragments = bindings.flatMap((binding) => [...(binding.promptFragments ?? [])]);
    const contextSources = bindings.flatMap((binding) => [...(binding.contextSources ?? [])]);
    const middleware = bindings.flatMap((binding) => [...(binding.middleware ?? [])]);
    unique(
      tools.map((tool) => id(tool.name, "tools.name")),
      "tools",
    );
    unique(
      promptFragments.map((fragment) => id(fragment.id, "promptFragments.id")),
      "promptFragments",
    );
    unique(
      contextSources.map((source) => id(source.id, "contextSources.id")),
      "contextSources",
    );
    unique(
      middleware.map((item) => id(item.id, "middleware.id")),
      "middleware",
    );
    for (const tool of tools)
      if (
        typeof tool.execute !== "function" ||
        !tool.parameters ||
        ("_zod" in tool.parameters
          ? tool.parameters._zod.def.type !== "object"
          : typeof tool.parameters.safeParse !== "function")
      )
        fail("tools", "invalid tool binding");
    for (const fragment of promptFragments)
      if (typeof fragment.text !== "string") fail("promptFragments", "expected text");
    for (const source of contextSources)
      if (typeof source.fetch !== "function") fail("contextSources", "missing fetch function");
    return { tools, promptFragments, contextSources, middleware: sortHarnessMiddleware(middleware), dispose };
  } catch (error) {
    await dispose();
    if (error instanceof Error && diagnostics.length) {
      // A frozen error from an adapter still remains the primary failure.
      try {
        Object.defineProperty(error, "cleanupDiagnostics", { value: [...diagnostics] });
      } catch {
        /* retain the original failure */
      }
    }
    throw error;
  }
}
