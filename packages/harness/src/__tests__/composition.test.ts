import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, RunContext } from "@agentium/core";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import {
  base,
  defineAbility,
  defineHarness,
  describeHarness,
  exportManifest,
  extendHarness,
  fileContext,
  loadManifest,
  research,
  suppliedTools,
  textContext,
} from "../index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const context = () =>
  new RunContext({ sessionId: "test", userId: "actor", tenantId: "tenant", eventBus: new EventBus() });
const budget = { maxEntries: 10, maxBytes: 10_000, deadlineMs: 1000 };

it("composes heterogeneous typed callbacks/services without binding during define/describe", () => {
  const bind = vi.fn(async () => ({ tools: [] }));
  const client = { query: vi.fn() };
  const callbacks = defineAbility({
    type: "test/callback",
    validate: (options: { callback: () => string }) => options,
    describe: () => ({ toolNames: [], requirements: [] }),
    bind,
  });
  const services = defineAbility({
    type: "test/service",
    validate: (options: { client: typeof client }) => options,
    describe: () => ({ toolNames: [], requirements: [] }),
    bind,
  });
  const definition = defineHarness({
    id: "local",
    abilities: [callbacks({ callback: () => "hello" }), services({ client })],
  });
  expect(describeHarness(definition).abilities).toHaveLength(2);
  expect(bind).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
  expect(Object.isFrozen(client)).toBe(false);
  expect(() => exportManifest(definition)).toThrow();
});

it("extends deterministically, disables a whole ability, preserves stable IDs and original data", () => {
  const original = defineHarness({
    id: "original",
    abilities: [textContext({ id: "notes", entries: [{ id: "one", text: "Hello" }] }, { instanceId: "notes" })],
    defaults: { filesystem: true, fileMemory: true },
  });
  const extended = extendHarness(original, { disable: ["notes"], defaults: { filesystem: false } });
  expect(describeHarness(extended)).toMatchObject({
    id: "original",
    abilities: [],
    defaults: { filesystem: false, fileMemory: true },
  });
  expect(describeHarness(original).abilities).toHaveLength(1);
  expect(() =>
    extendHarness(original, { abilities: [textContext({ id: "two", entries: [] }, { instanceId: "notes" })] }),
  ).toThrow();
});

it("exports registered JSON abilities and reloads only through approved factories", () => {
  const definition = defineHarness({
    id: "portable-notes",
    abilities: [textContext({ id: "notes", entries: [{ id: "one", text: "Hello" }] }, { instanceId: "notes" })],
  });
  const manifest = exportManifest(definition);
  expect(manifest.contractVersion).toBe(1);
  expect(() => loadManifest(manifest, [])).toThrow();
  const loaded = loadManifest(JSON.parse(JSON.stringify(manifest)), [textContext.factory!]);
  expect(exportManifest(loaded)).toEqual(manifest);
  expect(describeHarness(loaded).abilities[0].instanceId).toBe("notes");
});

it("redacts options in validation failures and never silently exports local clients", () => {
  const ability = defineAbility({
    type: "test/secrets",
    validate: (_options: { apiKey: string }): never => {
      throw new Error("secret-value");
    },
    describe: () => ({ toolNames: [], requirements: [] }),
    bind: async () => ({ tools: [] }),
  });
  expect(() => ability({ apiKey: "secret-value" })).toThrow("Invalid options for ability test/secrets");
  expect(() =>
    textContext({ id: "notes", entries: [{ id: "one", text: "value", apiKey: "secret" } as any] }),
  ).toThrow();
});

it("text contexts provide labelled source entries and fail explicitly when budgets are exceeded", async () => {
  const use = textContext({ id: "notes", entries: [{ id: "one", text: "हिन्दी", uri: "notes:test" }] });
  const source = (await use.bind(context())).contextSources![0];
  const result = await source.fetch("query", context(), budget);
  expect(result[0]).toMatchObject({
    trust: "source",
    byteLength: Buffer.byteLength("हिन्दी"),
    source: { uri: "notes:test" },
  });
  await expect(source.fetch("query", context(), { ...budget, maxBytes: 1 })).rejects.toThrow(/budget/);
});

it("research exposes real read-only scoped text/files and only opt-in tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentium-harness-"));
  dirs.push(root);
  const outside = await mkdtemp(join(tmpdir(), "agentium-harness-outside-"));
  dirs.push(outside);
  await writeFile(join(root, "notes.txt"), "Synthetic research notes");
  await writeFile(join(outside, "outside.txt"), "Synthetic external content");
  await symlink(outside, join(root, "escape"));
  const use = fileContext({ id: "files", root, files: ["notes.txt"] });
  const source = (await use.bind(context())).contextSources![0];
  expect((await source.fetch("query", context(), budget))[0].text).toBe("Synthetic research notes");
  await expect(source.fetch("query", context(), { ...budget, maxBytes: 1 })).rejects.toThrow(/budget/);
  const blocked = (await fileContext({ id: "escape", root, files: ["escape/outside.txt"] }).bind(context()))
    .contextSources![0];
  await expect(blocked.fetch("query", context(), budget)).rejects.toThrow(/outside/);
  const definition = research({ files: { id: "files", root, files: ["notes.txt"] } });
  expect(describeHarness(definition)).toMatchObject({
    toolNames: [],
    defaults: { filesystem: false },
  });
  expect(describeHarness(definition).defaults.workspace).toBeUndefined();
  expect(describeHarness(extendHarness(definition, { disable: ["research-files"] })).abilities).toEqual([]);
  expect(() => exportManifest(definition)).toThrow();
});

it("rejects path traversal at definition time and cancellation before file reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentium-harness-"));
  dirs.push(root);
  expect(() => fileContext({ id: "files", root, files: ["../outside"] })).toThrow();
  const controller = new AbortController();
  controller.abort();
  const ctx = new RunContext({ sessionId: "cancelled", signal: controller.signal, eventBus: new EventBus() });
  const source = (await fileContext({ id: "files", root, files: ["missing"] }).bind(ctx)).contextSources![0];
  await expect(source.fetch("query", ctx, budget)).rejects.toThrow();
});

it("presets are inert and research is explicitly read-only", () => {
  expect(describeHarness(base()).abilities).toEqual([]);
  expect(describeHarness(research()).toolNames).toEqual([]);
});

it("supplied tools preserve executable identity without freezing caller-owned implementations", async () => {
  const tool = {
    name: "search",
    description: "Synthetic search",
    parameters: z.object({}),
    execute: vi.fn(async () => "results"),
  };
  const ability = suppliedTools({ tools: [tool] });
  expect(ability.describe().toolNames).toEqual(["search"]);
  const binding = await ability.bind(context());
  expect(binding.tools[0].execute).toBe(tool.execute);
  expect(binding.tools[0].parameters).toBe(tool.parameters);
  expect(Object.isFrozen(tool)).toBe(false);
  expect(tool.execute).not.toHaveBeenCalled();
});

it("requires explicit portable instance IDs and redacts custom mapping failures", () => {
  const unnamed = defineHarness({ id: "named-harness", abilities: [textContext({ id: "notes", entries: [] })] });
  expect(() => exportManifest(unnamed)).toThrow(/portable/);
  const ability = defineAbility({
    type: "test/portable-error",
    validate: (options: { value: string }) => options,
    describe: () => ({ toolNames: [], requirements: [] }),
    bind: async () => ({ tools: [] }),
    portable: {
      validateOptions: (options) => options,
      toOptions: () => ({ value: "fixture" }),
      toJSON: () => {
        throw new Error("secret-option-value");
      },
    },
  });
  expect(() => ability({ value: "secret-option-value" }, { instanceId: "stable" })).toThrow(
    "Invalid portable options for ability test/portable-error",
  );
});

it("isolates declarative options between callers, bindings and descriptions while preserving class services", async () => {
  class Service {
    calls = 0;
  }
  const service = new Service();
  const options = { nested: { count: 0 }, items: ["first"], service, callback: () => "value" };
  const seen: unknown[] = [];
  const ability = defineAbility({
    type: "test/isolation",
    validate: (input: typeof options) => input,
    describe: (input) => {
      input.nested.count = 99;
      return { toolNames: [], requirements: [] };
    },
    bind: async (input) => {
      seen.push({
        count: input.nested.count,
        items: [...input.items],
        service: input.service,
        callback: input.callback,
      });
      input.nested.count += 1;
      input.items.push("changed");
      input.service.calls++;
      return { tools: [] };
    },
  });
  const use = ability(options);
  options.nested.count = 7;
  options.items.push("caller-change");
  use.describe();
  await use.bind(context());
  await use.bind(context());
  expect(seen).toEqual([
    { count: 0, items: ["first"], service, callback: options.callback },
    { count: 0, items: ["first"], service, callback: options.callback },
  ]);
  expect(options.nested.count).toBe(7);
  expect(service.calls).toBe(2);
  expect(Object.isFrozen(service)).toBe(false);
});
