import { EventBus, RunContext } from "@agentium/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import {
  bindHarness,
  createHarnessDefinition,
  describeHarnessDefinition,
  exportHarnessManifest,
  extendHarnessDefinition,
  hashHarnessManifest,
  loadHarnessManifest,
  resolveHarness,
  validateHarnessManifest,
} from "../resolve.js";
import type { AbilityFactory, HarnessManifest, LocalAbilityUse } from "../types.js";

function local(instanceId: string, changes: Partial<LocalAbilityUse> = {}): LocalAbilityUse {
  return {
    instanceId,
    validate: () => {},
    describe: () => ({ toolNames: [instanceId], requirements: [] }),
    bind: async () => ({
      tools: [{ name: instanceId, description: instanceId, parameters: z.object({}), execute: async () => instanceId }],
    }),
    ...changes,
  };
}
function factory(): AbilityFactory {
  return {
    type: "test",
    version: 1,
    validateOptions: (input) => input,
    describe: () => ({ toolNames: ["test"], requirements: [] }),
    bind: vi.fn(async () => ({ tools: [] })),
  };
}
function manifest(options = {}): HarnessManifest {
  return { contractVersion: 1, id: "test", abilities: [{ instanceId: "one", type: "test", version: 1, options }] };
}
function ctx(signal?: AbortSignal) {
  return new RunContext({ sessionId: "s", eventBus: new EventBus(), signal });
}

describe("portable harness contracts", () => {
  it("round-trips validated JSON and hashes canonical object order while retaining array order", () => {
    const approved = factory();
    const a = manifest({ z: { b: 2, a: 1 }, a: [1, 2] });
    const b = manifest({ a: [1, 2], z: { a: 1, b: 2 } });
    expect(hashHarnessManifest(a)).toBe(hashHarnessManifest(b));
    expect(hashHarnessManifest(a)).not.toBe(hashHarnessManifest(manifest({ a: [2, 1], z: { a: 1, b: 2 } })));
    expect(exportHarnessManifest(loadHarnessManifest(JSON.parse(JSON.stringify(a)), [approved]))).toEqual(a);
  });

  it.each([
    { ...manifest(), apiKey: "NEVER_PRINT_THIS_SECRET" },
    { ...manifest(), model: "not-H1" },
    { ...manifest(), contractVersion: 2 },
    manifest({ api_key: "NEVER_PRINT_THIS_SECRET" }),
    manifest({ nested: { accessToken: "NEVER_PRINT_THIS_SECRET" } }),
    manifest({ callback: () => {} }),
    manifest({ instance: new Date() }),
    manifest({ missing: undefined }),
    manifest({ value: Number.NaN }),
    manifest({ sparse: new Array(1) }),
    { ...manifest(), defaults: { workspace: { path: "a", mode: "read", unexpected: true } } },
  ])("rejects nonportable or unexpected data without disclosing values", (input) => {
    expect(() => validateHarnessManifest(input)).toThrow();
    try {
      validateHarnessManifest(input);
    } catch (error) {
      expect(String(error)).not.toContain("NEVER_PRINT_THIS_SECRET");
    }
  });

  it("rejects cycles, unknown factories and conflicting registry implementations", () => {
    const options: Record<string, unknown> = {};
    options.loop = options;
    expect(() => validateHarnessManifest(manifest(options))).toThrow(/cyclic/);
    expect(() => loadHarnessManifest(manifest(), [])).toThrow(/approved factory/);
    expect(() => loadHarnessManifest(manifest(), [factory(), factory()])).toThrow(/conflicting/);
  });

  it("validates a created portable definition once without repeatedly transforming options", () => {
    const approved = factory();
    approved.validateOptions = vi.fn((options) => ({ count: Number(options.count ?? 0) + 1 }));
    const definition = loadHarnessManifest(manifest({ count: 0 }), [approved]);
    describeHarnessDefinition(definition);
    resolveHarness(definition, { projectRoot: "/project" });
    expect(exportHarnessManifest(definition).abilities[0].options).toEqual({ count: 1 });
    expect(approved.validateOptions).toHaveBeenCalledTimes(1);
  });

  it("redacts factory validation exceptions and never mutates source options", () => {
    const approved = factory();
    approved.validateOptions = (options) => {
      options.extra = true;
      return options;
    };
    const source = manifest({ original: true });
    const loaded = loadHarnessManifest(source, [approved]);
    expect(source.abilities[0].options).toEqual({ original: true });
    expect(exportHarnessManifest(loaded).abilities[0].options).toEqual({ original: true, extra: true });
    approved.validateOptions = () => {
      throw new Error("NEVER_PRINT_THIS_SECRET");
    };
    expect(() => loadHarnessManifest(source, [approved])).toThrow(/validation failed/);
  });
});

describe("local composition and resolution", () => {
  it("accepts captured callbacks/services, keeps them unfrozen, and refuses portable export", async () => {
    const service = { calls: 0, callback: () => "ok" };
    const definition = createHarnessDefinition({
      id: "local",
      abilities: [
        local("service", {
          bind: async () => {
            service.calls++;
            return { tools: [] };
          },
        }),
      ],
    });
    expect(Object.isFrozen(service)).toBe(false);
    expect(() => exportHarnessManifest(definition)).toThrow(/portable selection/);
    const bound = await bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx());
    expect(service.calls).toBe(1);
    await bound.dispose();
    service.calls++;
    expect(service.callback()).toBe("ok");
  });

  it("describes without binding or auto-checking missing host requirements", () => {
    const bind = vi.fn(async () => ({ tools: [] }));
    const definition = createHarnessDefinition({
      id: "local",
      abilities: [
        local("one", {
          bind,
          describe: () => ({ toolNames: ["declared"], requirements: ["store"], runtimeDependent: true }),
        }),
      ],
    });
    expect(describeHarnessDefinition(definition)).toMatchObject({ requirements: ["store"], runtimeDependent: true });
    expect(bind).not.toHaveBeenCalled();
    expect(() => resolveHarness(definition, { projectRoot: "/project" })).toThrow(/missing host/);
    expect(resolveHarness(definition, { projectRoot: "/project", requirements: ["store"] }).description.id).toBe(
      "local",
    );
    expect(bind).not.toHaveBeenCalled();
  });

  it("preserves IDs, appends and explicitly replaces abilities, and removes complete disabled contributions", async () => {
    const base = createHarnessDefinition({ id: "base", abilities: [local("a"), local("b")] });
    const extended = extendHarnessDefinition(base, {
      disable: ["a"],
      replaceAbilities: [local("b", { describe: () => ({ toolNames: ["replacement"], requirements: [] }) })],
      abilities: [local("c")],
    });
    expect(describeHarnessDefinition(extended).abilities.map((ability) => ability.instanceId)).toEqual(["b", "c"]);
    expect(describeHarnessDefinition(base).abilities.map((ability) => ability.instanceId)).toEqual(["a", "b"]);
    expect(describeHarnessDefinition(extended).id).toBe("base");
    expect(describeHarnessDefinition(extended).diagnostics[0].code).toBe("ability_disabled");
    expect(() => extendHarnessDefinition(base, { abilities: [local("a")] })).toThrow(/duplicate/);
    expect(() => extendHarnessDefinition(base, { replaceAbilities: [local("missing")] })).toThrow(/existing/);
    expect(() => extendHarnessDefinition(base, { disable: ["missing"] })).toThrow(/unknown/);
  });

  it("merges defaults with stable absolute directory union, clear semantics and immutable source data", () => {
    const base = createHarnessDefinition({
      id: "base",
      defaults: { workspace: { path: "work", mode: "read" }, skillDirs: ["skills", "./shared"], filesystem: true },
      limits: { toolRoundtrips: 3 },
    });
    const more = extendHarnessDefinition(base, {
      defaults: { skillDirs: ["./skills", "new"], filesystem: false },
      limits: { maxChildDepth: 2 },
    });
    const resolved = resolveHarness(more, { projectRoot: "/project" });
    expect(resolved.defaults).toEqual({
      workspace: { path: "/project/work", mode: "read" },
      skillDirs: ["/project/skills", "/project/shared", "/project/new"],
      filesystem: false,
    });
    expect(resolved.limits).toEqual({ toolRoundtrips: 3, maxChildDepth: 2 });
    const cleared = extendHarnessDefinition(more, { defaults: { skillDirs: false, workspace: false } });
    const added = extendHarnessDefinition(cleared, { defaults: { skillDirs: ["later"] } });
    expect(resolveHarness(added, { projectRoot: "/project" }).defaults).toMatchObject({
      workspace: false,
      skillDirs: ["/project/later"],
    });
    expect(describeHarnessDefinition(base).defaults.skillDirs).toEqual(["skills", "./shared"]);
    expect(() => {
      (resolved.defaults.skillDirs as string[]).push("bad");
    }).toThrow();
    expect(resolveHarness(base, { projectRoot: "/other" }).defaults.workspace).toEqual({
      path: "/other/work",
      mode: "read",
    });
  });

  it("exports only explicitly named local definitions with approved portable mappings", () => {
    const approved = factory();
    const use = local("one", { portable: manifest().abilities[0], factory: approved });
    const unnamed = createHarnessDefinition({ abilities: [use] });
    expect(describeHarnessDefinition(extendHarnessDefinition(unnamed, {})).id).toBe(
      describeHarnessDefinition(unnamed).id,
    );
    expect(() => exportHarnessManifest(unnamed)).toThrow(/stable ID/);
    expect(exportHarnessManifest(extendHarnessDefinition(unnamed, { id: "stable" })).id).toBe("stable");
  });
});

describe("strict contract edge cases", () => {
  it("rejects unknown portable wrapper fields and invalid limits", () => {
    expect(() =>
      createHarnessDefinition({
        kind: "portable",
        manifest: manifest(),
        factories: [factory()],
        apiKey: "secret",
      } as never),
    ).toThrow(/unknown field/);
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => createHarnessDefinition({ id: "limits", limits: { toolRoundtrips: value } })).toThrow();
    }
  });

  it("preserves a frozen primary binding error even when cleanup fails", async () => {
    const failure = Object.freeze(new Error("primary"));
    const definition = createHarnessDefinition({
      id: "frozen",
      abilities: [
        local("a", {
          bind: async () => ({
            tools: [],
            dispose: async () => {
              throw new Error("cleanup");
            },
          }),
        }),
        local("b", {
          bind: async () => {
            throw failure;
          },
        }),
      ],
    });
    await expect(bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx())).rejects.toBe(failure);
  });

  it("cleans resources from a returned malformed binding", async () => {
    const dispose = vi.fn(async () => {});
    const definition = createHarnessDefinition({
      id: "invalid",
      abilities: [local("a", { bind: async () => ({ tools: null, dispose }) as never })],
    });
    await expect(bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx())).rejects.toThrow(
      /must contain tools/,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("per-run binding ownership", () => {
  it("binds sequentially for each actual context and cleans in reverse exactly once", async () => {
    const events: string[] = [];
    const definition = createHarnessDefinition({
      id: "bound",
      abilities: ["a", "b"].map((name) =>
        local(name, {
          bind: async (context) => {
            events.push(`bind:${name}:${context.runId}`);
            return {
              tools: [],
              dispose: async () => {
                events.push(`dispose:${name}`);
              },
            };
          },
        }),
      ),
    });
    const resolved = resolveHarness(definition, { projectRoot: "/project" });
    const first = await bindHarness(resolved, ctx());
    const second = await bindHarness(resolved, ctx());
    expect(events).toHaveLength(4);
    expect(events[0]).not.toBe(events[2]);
    await Promise.all([first.dispose(), first.dispose()]);
    expect(events.slice(4)).toEqual(["dispose:b", "dispose:a"]);
    await second.dispose();
    expect(events.slice(6)).toEqual(["dispose:b", "dispose:a"]);
  });

  it("preserves binding failure while recording reverse cleanup errors", async () => {
    const error = new Error("primary bind error");
    const cleanup = vi.fn(async () => {
      throw new Error("secret cleanup details");
    });
    const definition = createHarnessDefinition({
      id: "failure",
      abilities: [
        local("a", { bind: async () => ({ tools: [], dispose: cleanup }) }),
        local("b", {
          bind: async () => {
            throw error;
          },
        }),
      ],
    });
    await expect(bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx())).rejects.toBe(error);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((error as Error & { cleanupDiagnostics: unknown }).cleanupDiagnostics).toEqual([
      { code: "cleanup_failed", path: "abilities[0]", message: "Ability cleanup failed", severity: "warning" },
    ]);
  });

  it("cleans cancellation during binding and never starts later bindings", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn(async () => {});
    const later = vi.fn(async () => ({ tools: [] }));
    const definition = createHarnessDefinition({
      id: "cancel",
      abilities: [
        local("a", {
          bind: async () => {
            controller.abort();
            return { tools: [], dispose: cleanup };
          },
        }),
        local("b", { bind: later }),
      ],
    });
    await expect(
      bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx(controller.signal)),
    ).rejects.toThrow(/cancelled/);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });

  it("rejects duplicate tools, prompt fragments, source and middleware identifiers and disposes", async () => {
    for (const kind of ["tools", "promptFragments", "contextSources", "middleware"] as const) {
      const cleanup = vi.fn(async () => {});
      const shared = {
        tools: [{ name: "duplicate", description: "test", parameters: z.object({}), execute: async () => "ok" }],
        promptFragments: [{ id: "duplicate", text: "test" }],
        contextSources: [{ id: "duplicate", fetch: async () => [] }],
        middleware: [{ id: "duplicate" }],
      };
      const definition = createHarnessDefinition({
        id: "duplicates",
        abilities: ["a", "b"].map((name) =>
          local(name, { bind: async () => ({ tools: [], [kind]: shared[kind], dispose: cleanup }) }),
        ),
      });
      await expect(bindHarness(resolveHarness(definition, { projectRoot: "/project" }), ctx())).rejects.toThrow(
        /duplicate/,
      );
      expect(cleanup).toHaveBeenCalledTimes(2);
    }
  });
});
