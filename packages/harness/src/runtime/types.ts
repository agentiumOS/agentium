import type { ChatMessage, ModelResponse, RunContext, ToolCallResult, ToolDef } from "@agentium/core";
import type { HarnessRuntimeBindings, HarnessRuntimeReferences, HarnessRuntimeRegistry } from "./runtime-registry.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface AbilitySelection {
  instanceId: string;
  type: string;
  version: number;
  options: JsonObject;
}
export interface HarnessDefaults {
  workspace?: false | { path: string; mode: "read" | "write" };
  skillDirs?: readonly string[] | false;
  contextFiles?: boolean;
  filesystem?: boolean;
  subagents?: boolean;
  fileMemory?: boolean;
  searchPastSessions?: boolean;
}
export interface HarnessManifest {
  contractVersion: 1;
  runtime?: HarnessRuntimeReferences;
  id: string;
  abilities: readonly AbilitySelection[];
  defaults?: HarnessDefaults;
  limits?: { toolRoundtrips?: number; maxChildDepth?: number };
}
export interface PromptFragment {
  id: string;
  text: string;
}
export interface HarnessContextBudget {
  maxEntries: number;
  maxBytes: number;
  maxTokens?: number;
  deadlineMs: number;
}
export interface HarnessContextEntry {
  id: string;
  text: string;
  trust: "host" | "source";
  source?: { uri: string; version?: string; locator?: string };
  expiresAt?: number;
  estimatedTokens?: number;
  byteLength: number;
}
export interface HarnessContextSource {
  id: string;
  fetch: (query: string, ctx: RunContext, budget: HarnessContextBudget) => Promise<readonly HarnessContextEntry[]>;
}
export interface HarnessMiddleware {
  id: string;
  before?: readonly string[];
  after?: readonly string[];
  beforeModel?: (messages: readonly ChatMessage[], ctx: RunContext) => Promise<ChatMessage[]>;
  afterModel?: (response: ModelResponse, ctx: RunContext) => Promise<void>;
  afterTool?: (result: ToolCallResult, ctx: RunContext) => Promise<void>;
}
export interface AbilityBinding {
  tools: readonly ToolDef[];
  promptFragments?: readonly PromptFragment[];
  contextSources?: readonly HarnessContextSource[];
  middleware?: readonly HarnessMiddleware[];
  dispose?: () => Promise<void>;
}
export interface AbilityDescription {
  toolNames: readonly string[];
  requirements: readonly string[];
  runtimeDependent?: boolean;
}
export interface AbilityFactory {
  type: string;
  version: number;
  validateOptions: (input: JsonObject) => JsonObject;
  describe: (options: JsonObject) => AbilityDescription;
  bind: (options: JsonObject, ctx: RunContext) => Promise<AbilityBinding>;
}
export interface LocalAbilityUse {
  instanceId: string;
  validate: () => void;
  describe: () => AbilityDescription;
  bind: (ctx: RunContext) => Promise<AbilityBinding>;
  portable?: AbilitySelection;
  /** Trusted factory approved by the creator/host, never recovered from JSON. */
  factory?: AbilityFactory;
}
export type HarnessDefinition =
  | {
      readonly kind: "portable";
      readonly manifest: HarnessManifest;
      readonly factories: readonly AbilityFactory[];
      readonly runtimeRegistry?: HarnessRuntimeRegistry;
    }
  | {
      readonly kind: "local";
      readonly id?: string;
      readonly abilities: readonly LocalAbilityUse[];
      readonly defaults?: HarnessDefaults;
      readonly limits?: HarnessManifest["limits"];
      readonly runtime?: HarnessRuntimeBindings;
      readonly runtimeReferences?: HarnessRuntimeReferences;
      readonly runtimeRegistry?: HarnessRuntimeRegistry;
    };
export type HarnessDefinitionInput =
  | HarnessDefinition
  | {
      id?: string;
      abilities?: readonly LocalAbilityUse[];
      defaults?: HarnessDefaults;
      limits?: HarnessManifest["limits"];
      runtime?: HarnessRuntimeBindings;
      runtimeReferences?: HarnessRuntimeReferences;
      runtimeRegistry?: HarnessRuntimeRegistry;
    };
export interface HarnessExtension {
  runtime?: HarnessRuntimeBindings;
  runtimeReferences?: HarnessRuntimeReferences;
  runtimeRegistry?: HarnessRuntimeRegistry;
  id?: string;
  abilities?: readonly LocalAbilityUse[];
  disable?: readonly string[];
  replaceAbilities?: readonly LocalAbilityUse[];
  defaults?: HarnessDefaults;
  limits?: HarnessManifest["limits"];
}
export interface HarnessDiagnostic {
  code: string;
  path: string;
  message: string;
  severity: "info" | "warning" | "error";
}
export interface HarnessDescription {
  id: string;
  kind: "portable" | "local";
  contractVersion: 1;
  abilities: readonly (AbilityDescription & { instanceId: string; type?: string; version?: number })[];
  toolNames: readonly string[];
  requirements: readonly string[];
  runtimeDependent: boolean;
  defaults: HarnessDefaults;
  limits: NonNullable<HarnessManifest["limits"]>;
  diagnostics: readonly HarnessDiagnostic[];
}
export interface HarnessProvenance {
  path: string;
  origin: string;
}
export interface ResolvedHarness {
  readonly definition: HarnessDefinition;
  readonly defaults: HarnessDefaults;
  readonly limits: NonNullable<HarnessManifest["limits"]>;
  readonly description: HarnessDescription;
  readonly provenance: readonly HarnessProvenance[];
}
export interface BoundHarness {
  readonly tools: ToolDef[];
  readonly promptFragments: PromptFragment[];
  readonly contextSources: HarnessContextSource[];
  readonly middleware: HarnessMiddleware[];
  dispose: () => Promise<readonly HarnessDiagnostic[]>;
}
