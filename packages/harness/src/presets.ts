import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDef } from "@agentium/core";
import { canonicalSafeJoin, safeJoin } from "@agentium/core";
import { defineAbility, defineHarness } from "./definition.js";
import type { HarnessDefaults, HarnessDefinition, JsonObject, LocalAbilityUse } from "./runtime/index.js";

export interface TextContextOptions {
  id: string;
  entries: readonly { id: string; text: string; uri?: string }[];
}
function validateText(options: TextContextOptions): TextContextOptions {
  if (!options || typeof options.id !== "string" || !options.id || !Array.isArray(options.entries)) {
    throw new Error("Invalid text context options");
  }
  const ids = new Set<string>();
  const entries = options.entries.map((entry) => {
    if (
      !entry ||
      Object.keys(entry).some((key) => !["id", "text", "uri"].includes(key)) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.text !== "string" ||
      (entry.uri !== undefined && typeof entry.uri !== "string")
    )
      throw new Error("Invalid text context entry");
    ids.add(entry.id);
    return Object.freeze({ id: entry.id, text: entry.text, ...(entry.uri === undefined ? {} : { uri: entry.uri }) });
  });
  return Object.freeze({ id: options.id, entries: Object.freeze(entries) });
}

/** Static source data. These entries are always marked source, never host instructions. */
export const textContext = defineAbility<TextContextOptions>({
  type: "agentium/text-context",
  validate: validateText,
  describe: () => ({ toolNames: [], requirements: [] }),
  bind: async (options) => ({
    tools: [],
    contextSources: [
      {
        id: options.id,
        fetch: async (_query, ctx, budget) => {
          ctx.signal?.throwIfAborted();
          const entries = options.entries.map((entry) => ({
            id: entry.id,
            text: entry.text,
            trust: "source" as const,
            byteLength: Buffer.byteLength(entry.text, "utf8"),
            ...(entry.uri ? { source: { uri: entry.uri } } : {}),
          }));
          if (
            entries.length > budget.maxEntries ||
            entries.reduce((sum, entry) => sum + entry.byteLength, 0) > budget.maxBytes
          ) {
            throw new Error("Text context exceeds the supplied source budget");
          }
          return entries;
        },
      },
    ],
  }),
  portable: {
    validateOptions: (value) => {
      if (Object.keys(value).some((key) => !["id", "entries"].includes(key)))
        throw new Error("Unknown text context option");
      const parsed = validateText(value as unknown as TextContextOptions);
      return { id: parsed.id, entries: parsed.entries.map((entry) => ({ ...entry })) } as JsonObject;
    },
    toOptions: (value) => validateText(value as unknown as TextContextOptions),
    toJSON: (value) => ({ id: value.id, entries: value.entries.map((entry) => ({ ...entry })) }) as JsonObject,
  },
});

export interface FileContextOptions {
  id: string;
  /** Explicit host grant. Must be absolute; filesystem access begins only during fetch. */
  root: string;
  files: readonly string[];
}
/** Read only explicitly selected UTF-8 files within a canonical workspace. Local-only host capability. */
export const fileContext = defineAbility<FileContextOptions>({
  type: "agentium/file-context",
  validate: (options) => {
    if (
      !options ||
      typeof options.id !== "string" ||
      !options.id ||
      typeof options.root !== "string" ||
      !isAbsolute(options.root) ||
      !Array.isArray(options.files)
    )
      throw new Error("Invalid file context options");
    for (const file of options.files) {
      if (typeof file !== "string" || !file) throw new Error("Invalid file context path");
      safeJoin(options.root, file);
    }
    if (new Set(options.files).size !== options.files.length) throw new Error("Duplicate file context path");
    return Object.freeze({ id: options.id, root: options.root, files: Object.freeze([...options.files]) });
  },
  // The trusted caller explicitly grants these fixed files by constructing this local ability.
  describe: () => ({ toolNames: [], requirements: ["filesystem:read"], runtimeDependent: true }),
  bind: async (options) => ({
    tools: [],
    contextSources: [
      {
        id: options.id,
        fetch: async (_query, ctx, budget) => {
          if (options.files.length > budget.maxEntries)
            throw new Error("File context exceeds the supplied entry budget");
          const entries = [];
          let remaining = budget.maxBytes;
          const deadline = Date.now() + budget.deadlineMs;
          for (const file of options.files) {
            ctx.signal?.throwIfAborted();
            if (Date.now() > deadline) throw new Error("File context deadline exceeded");
            const path = await canonicalSafeJoin(options.root, file);
            const handle = await open(path, "r");
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > remaining)
                throw new Error("File context exceeds the supplied byte budget");
              const buffer = Buffer.alloc(stat.size + 1);
              let bytesRead = 0;
              while (bytesRead < buffer.length) {
                ctx.signal?.throwIfAborted();
                if (Date.now() > deadline) throw new Error("File context deadline exceeded");
                const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                if (!chunk.bytesRead) break;
                bytesRead += chunk.bytesRead;
              }
              if (bytesRead > stat.size) throw new Error("File changed while reading context");
              ctx.signal?.throwIfAborted();
              const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
              const byteLength = Buffer.byteLength(text, "utf8");
              remaining -= byteLength;
              entries.push({
                id: `${options.id}:${file}`,
                text,
                trust: "source" as const,
                byteLength,
                source: { uri: pathToFileURL(path).href, version: `${stat.mtimeMs}:${bytesRead}` },
              });
            } finally {
              await handle.close();
            }
          }
          return entries;
        },
      },
    ],
  }),
});

export interface SuppliedToolsOptions {
  tools: readonly ToolDef[];
  requirements?: readonly string[];
}
/** Application-owned search/document/service tools retain their existing ToolDef enforcement. */
export const suppliedTools = defineAbility<SuppliedToolsOptions>({
  type: "agentium/supplied-tools",
  validate: (options) => {
    if (
      !options ||
      !Array.isArray(options.tools) ||
      options.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== "string" ||
          !tool.name ||
          typeof tool.execute !== "function" ||
          !tool.parameters,
      )
    )
      throw new Error("Invalid supplied tools");
    if (options.requirements?.some((value) => typeof value !== "string" || !value))
      throw new Error("Invalid tool requirement");
    return Object.freeze({
      tools: Object.freeze([...options.tools]),
      requirements: Object.freeze([...(options.requirements ?? [])]),
    });
  },
  describe: (options) => ({
    toolNames: options.tools.map((tool) => tool.name),
    requirements: options.requirements ?? [],
  }),
  bind: async (options) => ({ tools: [...options.tools] }),
});

export interface BaseOptions {
  id?: string;
  abilities?: readonly LocalAbilityUse[];
  defaults?: HarnessDefaults;
}
/** Minimal local composition, no background jobs, learning, tools or provider selected implicitly. */
export function base(options: BaseOptions = {}): HarnessDefinition {
  return defineHarness({
    id: options.id ?? "agentium/base",
    abilities: options.abilities ?? [],
    defaults: options.defaults,
  });
}
export interface ResearchOptions extends BaseOptions {
  text?: TextContextOptions;
  files?: FileContextOptions;
  tools?: readonly ToolDef[];
}
/** Real context sources plus application-supplied research tools; no connector credentials or implicit web calls. */
export function research(options: ResearchOptions = {}): HarnessDefinition {
  return defineHarness({
    id: options.id ?? "agentium/research",
    abilities: [
      ...(options.text ? [textContext(options.text, { instanceId: "research-text" })] : []),
      ...(options.files ? [fileContext(options.files, { instanceId: "research-files" })] : []),
      ...(options.tools?.length ? [suppliedTools({ tools: options.tools }, { instanceId: "research-tools" })] : []),
      ...(options.abilities ?? []),
    ],
    defaults: {
      filesystem: false,
      contextFiles: false,
      fileMemory: false,
      subagents: false,
      ...options.defaults,
    },
  });
}
