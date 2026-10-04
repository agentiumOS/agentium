import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentConfig,
  type ChatMessage,
  InMemoryStorage,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  type RunContext,
  type StreamChunk,
  type ToolDefinition,
} from "@agentium/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentDriver, defineHarness, HarnessRuntime, type LocalAbilityUse } from "../index.js";

const identity = { tenantId: "migration-tenant", userId: "migration-actor" };
const start = { identity, sessionId: "migration-session" };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const toolIds = [
  "fs_read_file",
  "fs_list_directory",
  "fs_file_info",
  "fs_write_file",
  "list_skills",
  "get_skill_instructions",
  "get_skill_reference",
  "agent_fs_write",
  "agent_fs_read",
  "agent_fs_list",
  "agent_fs_search",
  "memory",
  "task",
  "search_past_sessions",
];
const done = (): ModelResponse => ({
  message: { role: "assistant", content: "migration complete" },
  finishReason: "stop",
  usage,
  raw: {},
});
function provider(
  generate: (
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ) => Promise<ModelResponse> = async () => done(),
): ModelProvider {
  return {
    providerId: "migration-fixture",
    modelId: "migration-fixture",
    generate: vi.fn(generate),
    async *stream(messages, options): AsyncGenerator<StreamChunk> {
      const response = await generate(messages, options);
      yield { type: "text", text: String(response.message.content ?? "") };
      yield { type: "finish", finishReason: response.finishReason, usage };
    },
  };
}
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentium-explicit-deep-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "skills", "migration-helper"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Use the migration fixture project instructions.");
  await writeFile(
    join(root, "skills", "migration-helper", "SKILL.md"),
    "---\nname: migration-helper\ndescription: Inspect the migration fixture safely.\n---\nOnly load this body when requested.",
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
function definition(abilities: LocalAbilityUse[] = []) {
  return defineHarness({
    id: "explicit-project-agent",
    abilities,
    defaults: {
      // Every historical Agent.deep choice is visible and editable. No preset or cwd write grant.
      workspace: { path: ".", mode: "write" },
      skillDirs: ["skills"],
      contextFiles: true,
      filesystem: true,
      subagents: true,
      fileMemory: true,
      searchPastSessions: true,
    },
    limits: { toolRoundtrips: 3, maxChildDepth: 1 },
  });
}
function lifecycle() {
  const contexts: RunContext[] = [];
  const dispose = vi.fn(async () => {});
  const ability: LocalAbilityUse = {
    instanceId: "run-resource",
    validate() {},
    describe: () => ({ toolNames: [], requirements: [] }),
    bind: async (ctx) => {
      contexts.push(ctx);
      return { tools: [], dispose };
    },
  };
  return { ability, contexts, dispose };
}
describe("explicit Agent.deep migration through the harness-owned Agent driver", () => {
  it.each([true, { cwd: "nested" }, { cwd: undefined }] satisfies NonNullable<AgentConfig["contextFiles"]>[])(
    "roots explicit workspace read/write, skills and context files without a definition (%j)",
    async (contextFiles) => {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "nested", "AGENTS.md"), "Nested project context marker.");
      const inputPath = join(root, "fixture-input.txt");
      const outputPath = join(root, "fixture-output.txt");
      await writeFile(inputPath, "Project-root read marker.");
      const observed: ChatMessage[][] = [];
      const model = provider(async (messages) => {
        observed.push(structuredClone(messages));
        if (messages.some((message) => message.role === "tool")) return done();
        return {
          message: {
            role: "assistant",
            content: null,
            toolCalls: [
              { id: "root-read", name: "fs_read_file", arguments: { path: inputPath } },
              {
                id: "root-write",
                name: "fs_write_file",
                arguments: { path: outputPath, content: "Project-root write marker." },
              },
            ],
          },
          finishReason: "tool_calls",
          usage,
          raw: {},
        };
      });
      const runtime = new HarnessRuntime({
        projectRoot: root,
        driver: agentDriver({
          name: "rooted-explicit",
          model,
          workspace: { path: ".", mode: "write" },
          skillDirs: ["skills"],
          contextFiles,
          retry: { maxRetries: 0 },
        }),
        grants: {
          toolIds: ["fs_read_file", "fs_write_file", "list_skills", "get_skill_instructions", "get_skill_reference"],
          modelRoles: ["main"],
        },
        budgets: { maxModelCalls: 2, maxToolCalls: 2 },
      });
      expect((await runtime.run("Read and write within the selected project", start)).status).toBe("completed");
      expect(await readFile(outputPath, "utf8")).toBe("Project-root write marker.");
      const prompt = observed[0]
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      expect(prompt).toContain("migration fixture project instructions");
      expect(prompt).toContain("migration-helper: Inspect the migration fixture safely.");
      if (typeof contextFiles === "object" && contextFiles.cwd === "nested")
        expect(prompt).toContain("Nested project context marker.");
      expect(observed[1].find((message) => message.toolCallId === "root-read")?.content).toContain(
        "Project-root read marker.",
      );
    },
  );
  it.each([false, true])(
    "exposes the requested tools and rooted project/skill prompt; cleans up each owned run (stream=%s)",
    async (stream) => {
      const observed: Array<{ messages: ChatMessage[]; names: string[] }> = [];
      const resource = lifecycle();
      const model = provider(async (messages, options) => {
        observed.push({ messages, names: options?.tools?.map((tool) => tool.name) ?? [] });
        return done();
      });
      const close = vi.spyOn(Agent.prototype, "close");
      const runtime = new HarnessRuntime({
        definition: definition([resource.ability]),
        projectRoot: root,
        driver: agentDriver(
          { name: "explicit", model, instructions: "Host instructions.", retry: { maxRetries: 0 } },
          { stream },
        ),
        grants: { toolIds, modelRoles: ["main"] },
        budgets: { maxModelCalls: 2, maxToolCalls: 1 },
      });
      expect(resource.contexts).toEqual([]);
      expect(observed).toEqual([]);
      for (const sessionId of ["first", "second"])
        expect((await runtime.run("Inspect this project", { identity, sessionId })).status).toBe("completed");
      expect(observed).toHaveLength(2);
      for (const sent of observed) {
        expect(sent.names.sort()).toEqual([...toolIds].sort());
        const text = sent.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        expect(text).toContain("Host instructions.");
        expect(text).toContain("migration fixture project instructions");
        expect(text).toContain("migration-helper: Inspect the migration fixture safely.");
        expect(text).not.toContain("Only load this body when requested.");
      }
      expect(resource.contexts).toHaveLength(2);
      expect(resource.contexts.map((ctx) => ctx.tenantId)).toEqual([identity.tenantId, identity.tenantId]);
      expect(new Set(resource.contexts.map((ctx) => ctx.runId)).size).toBe(2);
      expect(resource.dispose).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledWith({ closeStorage: false });
      expect(close.mock.instances[0]).not.toBe(close.mock.instances[1]);
    },
  );
  it.each(["policy", "tool-budget"] as const)(
    "keeps workspace writes behind shared %s enforcement",
    async (deniedBy) => {
      const model = provider(async (messages) =>
        messages.some((message) => message.role === "tool")
          ? done()
          : {
              message: {
                role: "assistant",
                content: null,
                toolCalls: [
                  { id: "write", name: "fs_write_file", arguments: { path: "blocked.txt", content: "must not write" } },
                ],
              },
              usage,
              finishReason: "tool_calls",
              raw: {},
            },
      );
      const resource = lifecycle();
      const runtime = new HarnessRuntime({
        definition: definition([resource.ability]),
        projectRoot: root,
        driver: agentDriver({ name: "explicit", model, retry: { maxRetries: 0 } }),
        grants: { toolIds, modelRoles: ["main"] },
        budgets: { maxModelCalls: 2, maxToolCalls: deniedBy === "tool-budget" ? 0 : 1 },
        executionPolicy: { decide: () => ({ action: deniedBy === "policy" ? "deny" : "allow" }) },
      });
      expect((await runtime.run("Write", start)).status).toBe("completed");
      await expect(readFile(join(root, "blocked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const lease = await runtime.sessions.acquire(identity, start.sessionId);
      expect(JSON.stringify(lease.read().history.find((message) => message.role === "tool"))).toMatch(/denied|budget/i);
      lease.release();
      expect(resource.dispose).toHaveBeenCalledOnce();
    },
  );
  it("shares model budgets with an actual child delegation instead of rebinding another harness", async () => {
    const resource = lifecycle();
    const model = provider(async (messages) =>
      String(messages.at(-1)?.content).includes("child work")
        ? done()
        : {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "task", name: "task", arguments: { task: "child work" } }],
            },
            finishReason: "tool_calls",
            usage,
            raw: {},
          },
    );
    const close = vi.spyOn(Agent.prototype, "close");
    const runtime = new HarnessRuntime({
      definition: definition([resource.ability]),
      projectRoot: root,
      driver: agentDriver({ name: "explicit", model, retry: { maxRetries: 0 } }),
      grants: { toolIds, modelRoles: ["main"] },
      budgets: { maxModelCalls: 2, maxToolCalls: 1 },
    });
    expect(await runtime.run("Delegate", start)).toMatchObject({
      status: "stopped",
      reason: { code: "budget_exhausted" },
    });
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(resource.contexts).toHaveLength(1);
    expect(resource.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2); // Child and its run-owned parent, never an extra ability binding.
  });
  it("disposes the configured Agent and binding when the provider fails", async () => {
    const resource = lifecycle();
    const close = vi.spyOn(Agent.prototype, "close");
    const model = provider(async () => {
      throw new Error("primary provider failure");
    });
    const runtime = new HarnessRuntime({
      definition: definition([resource.ability]),
      projectRoot: root,
      driver: agentDriver({ name: "explicit", model, retry: { maxRetries: 0 } }),
      grants: { toolIds, modelRoles: ["main"] },
    });
    expect(await runtime.run("Fail", start)).toMatchObject({
      status: "failed",
      reason: { message: "primary provider failure" },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(resource.dispose).toHaveBeenCalledOnce();
  });
  it("does not close caller-owned backing storage when disposing its configured Agent", async () => {
    const storage = new InMemoryStorage();
    await storage.set("host", "retained", { value: true });
    const close = vi.spyOn(storage, "close");
    const runtime = new HarnessRuntime({
      definition: definition(),
      projectRoot: root,
      driver: agentDriver({ name: "explicit", model: provider(), memory: { storage, summaries: false } }),
      grants: { toolIds, modelRoles: ["main"] },
    });
    expect((await runtime.run("Complete", start)).status).toBe("completed");
    expect(close).not.toHaveBeenCalled();
    expect(await storage.get("host", "retained")).toEqual({ value: true });
    await storage.close();
  });
  it("preserves a primary provider failure when Agent cleanup also fails", async () => {
    vi.spyOn(Agent.prototype, "close").mockRejectedValueOnce(new Error("cleanup failure"));
    const runtime = new HarnessRuntime({
      definition: definition(),
      projectRoot: root,
      driver: agentDriver({
        name: "explicit",
        model: provider(async () => {
          throw new Error("primary provider failure");
        }),
        retry: { maxRetries: 0 },
      }),
      grants: { toolIds, modelRoles: ["main"] },
    });
    expect(await runtime.run("Fail", start)).toMatchObject({
      status: "failed",
      reason: { message: "primary provider failure" },
      cleanupDiagnostics: ["resource_release_failed"],
    });
  });
});
it("retains explicitly backed standing notes and virtual files across run-owned Agent instances", async () => {
  const storage = new InMemoryStorage();
  const closeStorage = vi.spyOn(storage, "close");
  const observed: ChatMessage[][] = [];
  const model = provider(async (messages) => {
    observed.push(structuredClone(messages));
    if (messages.at(-1)?.role !== "user") return done();
    const save = messages.at(-1)?.content === "remember";
    return {
      message: {
        role: "assistant",
        content: null,
        toolCalls: save
          ? [
              {
                id: "note",
                name: "memory",
                arguments: { action: "add", target: "memory", content: "Standing migration note." },
              },
              {
                id: "write",
                name: "agent_fs_write",
                arguments: { path: "note.txt", content: "Persistent virtual file." },
              },
            ]
          : [{ id: "read", name: "agent_fs_read", arguments: { path: "note.txt" } }],
      },
      usage,
      finishReason: "tool_calls",
      raw: {},
    };
  });
  const runtime = new HarnessRuntime({
    definition: definition(),
    projectRoot: root,
    driver: agentDriver({
      name: "persistent-project",
      model,
      retry: { maxRetries: 0 },
      memory: { storage, summaries: false },
    }),
    grants: { toolIds, modelRoles: ["main"] },
    budgets: { maxModelCalls: 2, maxToolCalls: 2 },
  });
  expect((await runtime.run("remember", start)).status).toBe("completed");
  expect((await runtime.run("recall", start)).status).toBe("completed");
  expect(
    observed[2]
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n"),
  ).toContain("Standing migration note.");
  expect(observed[3].filter((message) => message.role === "tool").at(-1)?.content).toContain(
    "Persistent virtual file.",
  );
  expect(closeStorage).not.toHaveBeenCalled();
  // Runtime owns canonical conversation storage; automatic Agent sessions remain disabled.
  expect(await storage.list("sessions")).toEqual([]);
  await storage.close();
});
