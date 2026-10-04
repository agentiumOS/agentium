import { randomUUID } from "node:crypto";
import type { RunContext } from "@agentium/core";
import type { AbilityBinding } from "./runtime/index.js";
import {
  type AbilityFactory,
  createHarnessDefinition,
  describeHarnessDefinition,
  exportHarnessManifest,
  extendHarnessDefinition,
  hashHarnessManifest,
  type JsonObject,
  type LocalAbilityUse,
  loadHarnessManifest,
} from "./runtime/index.js";

export interface AbilityDescription {
  toolNames: readonly string[];
  requirements: readonly string[];
  runtimeDependent?: boolean;
}

export interface AbilityDefinition<Options> {
  type: string;
  version?: number;
  /** Pure validation/snapshotting. Preserve caller-owned service references; never freeze clients. */
  validate: (options: Options) => Options;
  describe: (options: Options) => AbilityDescription;
  bind: (options: Options, ctx: RunContext) => AbilityBinding | Promise<AbilityBinding>;
  /** Explicit trusted mapping. Omit for local callbacks/services that cannot be serialized. */
  portable?: {
    validateOptions: (options: JsonObject) => JsonObject;
    toOptions: (options: JsonObject) => Options;
    toJSON: (options: Options) => JsonObject;
  };
}

export interface Ability<Options> {
  (options: Options, config?: { instanceId?: string }): LocalAbilityUse;
  readonly type: string;
  readonly version: number;
  readonly factory?: AbilityFactory;
}

/** Clone only declarative containers. Classes/functions remain caller-owned service references. */
function snapshot<T>(value: T, freeze = false, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return seen.get(value) as T;
  const copy: any = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: snapshot((value as Record<string, unknown>)[key], freeze, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return (freeze ? Object.freeze(copy) : copy) as T;
}

/** Capture typed local options; erase only the wrapper so heterogeneous abilities compose without casts. */
export function defineAbility<Options>(definition: AbilityDefinition<Options>): Ability<Options> {
  definition = Object.freeze({
    ...definition,
    ...(definition.portable ? { portable: Object.freeze({ ...definition.portable }) } : {}),
  });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(definition.type)) throw new Error("Ability type is invalid");
  const version = definition.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Ability version must be a positive integer");
  const validate = (options: Options): Options => {
    try {
      return definition.validate(options);
    } catch {
      throw new Error(`Invalid options for ability ${definition.type}`);
    }
  };
  const mapping = definition.portable;
  const factory: AbilityFactory | undefined = mapping
    ? Object.freeze({
        type: definition.type,
        version,
        validateOptions: mapping.validateOptions,
        describe: (options: JsonObject) =>
          definition.describe(snapshot(validate(snapshot(mapping.toOptions(options))))),
        bind: async (options: JsonObject, ctx: RunContext) =>
          definition.bind(snapshot(validate(snapshot(mapping.toOptions(options)))), ctx),
      })
    : undefined;
  const use = (options: Options, config?: { instanceId?: string }): LocalAbilityUse => {
    const captured = snapshot(validate(snapshot(options)), true);
    const instanceId = config?.instanceId ?? `${definition.type}:${randomUUID()}`;
    let portable: LocalAbilityUse["portable"];
    if (mapping && config?.instanceId) {
      try {
        portable = snapshot(
          {
            instanceId,
            type: definition.type,
            version,
            options: mapping.validateOptions(mapping.toJSON(snapshot(captured))),
          },
          true,
        );
      } catch {
        throw new Error(`Invalid portable options for ability ${definition.type}`);
      }
    }
    return Object.freeze({
      instanceId,
      validate: () => {
        validate(snapshot(captured));
      },
      describe: () => definition.describe(snapshot(captured)),
      bind: async (ctx: RunContext) => definition.bind(snapshot(captured), ctx),
      ...(portable && factory ? { portable, factory } : {}),
    });
  };
  return Object.freeze(Object.assign(use, { type: definition.type, version, ...(factory ? { factory } : {}) }));
}

export const defineHarness = createHarnessDefinition;
export const extendHarness = extendHarnessDefinition;
export const describeHarness = describeHarnessDefinition;
export const exportManifest = exportHarnessManifest;
export const loadManifest = loadHarnessManifest;

export const hashManifest = hashHarnessManifest;
