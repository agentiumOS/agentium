import type { ContextPolicy } from "./context-policy.js";
import type { CompletionPolicy, StepController } from "./controller.js";
import type { ExecutionDriver } from "./driver.js";
import type { HarnessDefinition } from "./types.js";

export interface HarnessRegistryReference {
  id: string;
  version: number;
}
export interface HarnessRuntimeReferences {
  driver?: HarnessRegistryReference;
  controller?: HarnessRegistryReference;
  contextPolicy?: HarnessRegistryReference;
  completionPolicy?: HarnessRegistryReference;
  /** Role -> approved host binding name; credentials/providers stay host-owned. */
  modelRoles?: Readonly<Record<string, string>>;
}
export interface HarnessRuntimeBindings {
  driver?: ExecutionDriver;
  controller?: StepController;
  contextPolicy?: ContextPolicy;
  completionPolicy?: CompletionPolicy;
  modelRoles?: Readonly<Record<string, string>>;
}
export interface HarnessRegistryEntry<T> extends HarnessRegistryReference {
  implementation: T;
}
export interface HarnessRuntimeRegistry {
  driver?: readonly HarnessRegistryEntry<ExecutionDriver>[];
  controller?: readonly HarnessRegistryEntry<StepController>[];
  contextPolicy?: readonly HarnessRegistryEntry<ContextPolicy>[];
  completionPolicy?: readonly HarnessRegistryEntry<CompletionPolicy>[];
}
/** Registry resolution is static; it never initializes providers or executes drivers. */
export function resolveHarnessRuntime(definition: HarnessDefinition): HarnessRuntimeBindings {
  const references = definition.kind === "portable" ? definition.manifest.runtime : definition.runtimeReferences;
  const direct = definition.kind === "local" ? definition.runtime : undefined;
  const result: HarnessRuntimeBindings = { ...direct, modelRoles: direct?.modelRoles ?? references?.modelRoles };
  for (const key of ["driver", "controller", "contextPolicy", "completionPolicy"] as const) {
    const reference = references?.[key];
    if (!reference) continue;
    const entries = definition.runtimeRegistry?.[key] ?? [];
    const matches = entries.filter((entry) => entry.id === reference.id && entry.version === reference.version);
    if (matches.length !== 1)
      throw new Error(
        `runtime.${key}: expected exactly one approved registry implementation for ${reference.id}@${reference.version}`,
      );
    const implementation = matches[0].implementation;
    if (direct?.[key] && direct[key] !== implementation)
      throw new Error(`runtime.${key}: direct binding differs from its approved export mapping`);
    (result as Record<string, unknown>)[key] = implementation;
  }
  return Object.freeze(result);
}
