import { Agent, type DurableJSON, type ModelProvider } from "@agentium/core";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";
import { z as z4 } from "zod/v4";
import {
  ExecutionPlanValidationError,
  graphCatalogDescriptor,
  graphCatalogDigest,
  resolvePlanArguments,
  validateExecutionPlan,
} from "../execution-proposal.js";
import type { ExecutionPlan, GraphBinding, GraphToolBinding, PlanValidationLimits } from "../graph-contracts.js";

const limits: PlanValidationLimits = { maxBytes: 10000, maxNodes: 20, maxDepth: 20, maxConcurrency: 3, durable: true };
function tool(id = "read"): GraphToolBinding {
  return {
    id,
    version: "1",
    kind: "tool",
    input: z.object({ value: z.number() }),
    output: z.object({ answer: z.number() }),
    recovery: "pure",
    referenceInputs: ["value"],
    referenceOutputs: ["answer"],
    validateTemplate(template) {
      if (Object.keys(template).join(",") !== "value") throw new Error("Expected only value");
    },
    tool: {
      name: id,
      description: "fixture",
      parameters: z.object({ value: z.number() }),
      execute: async () => {
        throw new Error("must not dispatch during validation");
      },
    },
  };
}
function plan(): ExecutionPlan {
  return {
    schemaVersion: 1,
    revision: 1,
    nodes: [
      {
        id: "consumer",
        binding: "read",
        version: "1",
        args: { value: { $ref: { node: "producer", path: ["answer"] } } },
      },
      { id: "producer", binding: "read", version: "1", args: { value: 4 } },
    ],
  };
}
function invalid(
  value: unknown,
  catalog: readonly GraphBinding[] = [tool()],
  overrides: Partial<PlanValidationLimits> = {},
) {
  expect(() => validateExecutionPlan(value, catalog, { ...limits, ...overrides })).toThrow(
    ExecutionPlanValidationError,
  );
}

describe("trusted execution proposal admission", () => {
  it("inherits dynamic episode depth for dependencies and rejects exhausted depth before callbacks", () => {
    expect(validateExecutionPlan(plan(), [tool()], limits, 19).order).toHaveLength(2);
    expect(() => validateExecutionPlan(plan(), [tool()], limits, 20)).toThrow(ExecutionPlanValidationError);
    for (const depth of [0, 1.5, 21])
      expect(() =>
        validateExecutionPlan({ schemaVersion: 1, revision: 1, nodes: [] }, [tool()], limits, depth),
      ).toThrow(ExecutionPlanValidationError);
    expect(validateExecutionPlan(plan(), [tool()], limits, 19).catalogDigest).toBe(
      graphCatalogDigest([tool()], limits),
    );
  });
  it("accepts Zod4 catalog schemas without persisting native nonenumerable runtime annotations", () => {
    const binding = tool();
    binding.input = z4.object({ value: z4.number() });
    binding.output = z4.object({ answer: z4.number() });
    binding.tool = { ...binding.tool, parameters: z4.object({ value: z4.number() }) };
    const result = validateExecutionPlan(plan(), [binding], limits);
    expect(result.order).toEqual(["producer", "consumer"]);
    const descriptor = graphCatalogDescriptor([binding], limits);
    expect(descriptor[0]).toEqual(
      expect.objectContaining({ input: expect.objectContaining({ type: "object", required: ["value"] }) }),
    );
    expect(JSON.stringify(descriptor)).not.toContain("~standard");
  });
  it("infers producer data dependencies and returns stable topological order without changing the proposal", () => {
    const proposal = plan();
    const result = validateExecutionPlan(proposal, [tool()], limits);
    expect(result.order).toEqual(["producer", "consumer"]);
    expect(result.plan.nodes[0].inputsFrom).toEqual(["producer"]);
    expect(result.referenceRequirements).toEqual([
      { consumer: "consumer", producer: "producer", outputPath: ["answer"], argumentPath: ["value"] },
    ]);
    expect(proposal.nodes[0].inputsFrom).toBeUndefined();
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.catalogDigest).toBe(graphCatalogDigest([tool()], limits));
  });
  it("validates literal inputs without replaying input transforms into the template", () => {
    const binding = tool();
    binding.input = z.object({ value: z.string().transform(Number) });
    const proposal = { ...plan(), nodes: [{ id: "only", binding: "read", version: "1", args: { value: "7" } }] };
    expect(validateExecutionPlan(proposal, [binding], limits).plan.nodes[0].args).toEqual({ value: "7" });
  });
  it.each([
    ["duplicate nodes", { ...plan(), nodes: [plan().nodes[1], plan().nodes[1]] }],
    ["missing producer", { ...plan(), nodes: [plan().nodes[0]] }],
    ["unknown binding", { ...plan(), nodes: [{ ...plan().nodes[1], binding: "arbitraryCode" }] }],
    ["changed binding version", { ...plan(), nodes: [{ ...plan().nodes[1], version: "2" }] }],
    [
      "cycle through inferred data reference",
      { ...plan(), nodes: [plan().nodes[0], { ...plan().nodes[1], dependsOn: ["consumer"] }] },
    ],
    ["self edge", { ...plan(), nodes: [{ ...plan().nodes[1], dependsOn: ["producer"] }] }],
    ["missing declared control", { ...plan(), nodes: [{ ...plan().nodes[1], dependsOn: ["lost"] }] }],
    [
      "duplicate declared edge",
      { ...plan(), nodes: [{ ...plan().nodes[0], dependsOn: ["producer", "producer"] }, plan().nodes[1]] },
    ],
    ["invalid literal", { ...plan(), nodes: [{ ...plan().nodes[1], args: { value: "bad" } }] }],
    ["code field", { ...plan(), code: "execute()" }],
    ["grant field", { ...plan(), nodes: [{ ...plan().nodes[1], grants: ["all"] }] }],
    ["revision zero", { ...plan(), revision: 0 }],
    ["fractional revision", { ...plan(), revision: 1.5 }],
    ["bad concurrency", { ...plan(), maxConcurrency: 4 }],
    ["merge invention", { ...plan(), merge: "fastest" }],
    ["malformed Unicode ID", { ...plan(), nodes: [{ ...plan().nodes[1], id: "\ud800" }] }],
    ["unsafe ID", { ...plan(), nodes: [{ ...plan().nodes[1], id: "__proto__" }] }],
  ])("rejects %s before dispatch", (_name, proposal) => invalid(proposal));
  it("enforces bytes, nodes and JSON depth before catalog callbacks", () => {
    invalid(plan(), [tool()], { maxBytes: 20 });
    invalid(plan(), [tool()], { maxNodes: 1 });
    invalid(plan(), [tool()], { maxDepth: 4 });
  });
  it("rejects unsafe keys, getters, nonfinite values and recursive data", () => {
    const recursive: Record<string, unknown> = {};
    recursive.self = recursive;
    for (const args of [
      JSON.parse('{"__proto__":1}'),
      { value: Infinity },
      { value: recursive },
      Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          throw new Error("must not read getter");
        },
      }),
    ]) {
      invalid({ ...plan(), nodes: [{ ...plan().nodes[1], args }] });
    }
  });
  it("requires a host template validator and exact input/output reference declarations", () => {
    const binding = tool();
    delete binding.validateTemplate;
    invalid(plan(), [binding]);
    invalid(plan(), [{ ...tool(), referenceInputs: ["other"] }]);
    invalid(plan(), [{ ...tool(), referenceOutputs: ["other"] }]);
    invalid(plan(), [
      {
        ...tool(),
        validateTemplate() {
          throw new Error("Host template rejected");
        },
      },
    ]);
  });
  it.each([
    { $ref: { node: "producer", path: ["constructor"] } },
    { $ref: { node: "producer", path: ["answer.x"] } },
    { $ref: { node: "producer", path: ["answer"], code: true } },
    { $ref: { node: "producer", path: ["answer"] }, extra: 1 },
    { $ref: "producer.answer" },
  ])("rejects malformed or unsafe reference %j", (value) =>
    invalid({ ...plan(), nodes: [{ ...plan().nodes[0], args: { value } }, plan().nodes[1]] }),
  );
  it("requires supported tool recovery in durable mode but preserves ordinary opt-in execution", () => {
    const binding = tool();
    delete binding.recovery;
    invalid(plan(), [binding]);
    expect(validateExecutionPlan(plan(), [binding], { ...limits, durable: false }).order).toHaveLength(2);
  });
  it.each(["cache", "toModelOutput"] as const)(
    "rejects durable catalog tool %s without a recorded policy before admission",
    (option) => {
      const binding = tool();
      binding.tool = {
        ...binding.tool,
        ...(option === "cache" ? { cache: { ttl: 10000 } } : { toModelOutput: async () => "transformed" }),
      };
      invalid(plan(), [binding]);
      expect(validateExecutionPlan(plan(), [binding], { ...limits, durable: false }).order).toHaveLength(2);
    },
  );
  it("accepts a versioned connector and rejects missing receipt resolution", () => {
    const binding = tool();
    binding.recovery = {
      destination: "fixture",
      connector: { version: "1", dispatch: async () => ({ resultRef: "saved" }) },
      resolveResult: async () => ({ answer: 1 }),
    };
    expect(validateExecutionPlan(plan(), [binding], limits).order).toHaveLength(2);
    invalid(plan(), [
      {
        ...binding,
        recovery: { connector: binding.recovery.connector, destination: "fixture" },
      } as unknown as GraphBinding,
    ]);
  });
  it("validates every catalog entry and rejects duplicate identities", () => {
    invalid(plan(), [tool(), tool()]);
    invalid(plan(), [tool(), { ...tool("unsafe"), recovery: undefined }]);
  });
  it("rejects ambiguous executable tool names across catalog bindings", () => {
    const alias = tool("alias");
    alias.tool = { ...alias.tool, name: "read" };
    invalid(plan(), [tool(), alias]);
  });
  it("bounds the dependency depth independently of flat JSON and total node count", () => {
    const nodes = Array.from({ length: 11 }, (_, index) => ({
      id: `n${index}`,
      binding: "read",
      version: "1",
      args: { value: index },
      ...(index ? { dependsOn: [`n${index - 1}`] } : {}),
    }));
    invalid({ schemaVersion: 1, revision: 1, nodes }, [tool()], { maxDepth: 10 });
  });
  it("validates nested static programs and rejects recursive structural bindings without evaluating repeat guards", () => {
    const nested: GraphBinding = {
      id: "nested",
      version: "1",
      kind: "repeat",
      input: z.object({}),
      output: z.object({}),
      maxIterations: 2,
      while() {
        throw new Error("must not evaluate guard");
      },
      program: {
        id: "body",
        version: "1",
        plan: {
          schemaVersion: 1,
          revision: 1,
          nodes: [{ id: "child", binding: "read", version: "1", args: { value: 2 } }],
        },
      },
    };
    expect(validateExecutionPlan(plan(), [tool(), nested], limits).order).toHaveLength(2);
    nested.program.plan = {
      schemaVersion: 1,
      revision: 1,
      nodes: [{ id: "recurse", binding: "nested", version: "1", args: {} }],
    };
    invalid(plan(), [tool(), nested]);
  });
  it("requires all declared Agent tools to resolve to safe catalog tool bindings", () => {
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async () => {
        throw new Error("must not generate");
      },
      stream() {
        throw new Error("must not stream");
      },
    };
    const approved = tool();
    const binding: GraphBinding = {
      id: "agent",
      version: "1",
      kind: "agent",
      agent: new Agent({ name: "fixture", model: provider, tools: [approved.tool], maxTokens: 32, register: false }),
      tools: ["read"],
      input: z.object({}),
      output: z.object({}),
    };
    expect(validateExecutionPlan(plan(), [approved, binding], limits).order).toHaveLength(2);
    invalid(plan(), [approved, { ...binding, tools: ["lost"] }]);
    invalid(plan(), [approved, { ...binding, tools: [] }]);
    invalid(plan(), [tool(), binding]);
    invalid(plan(), [{ ...approved, tool: { ...approved.tool, requiresApproval: true } }, binding]);
  });
  it("accepts cloned Agent-local sandbox data and rejects changed permissions or model-visible contracts", () => {
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async () => {
        throw new Error("must not generate");
      },
      stream() {
        throw new Error("must not stream");
      },
    };
    const approved = tool();
    approved.tool = {
      ...approved.tool,
      sandbox: { allowNetwork: false, allowFS: { readOnly: ["/repo"] } },
      rawJsonSchema: { type: "object" },
      inputExamples: [{ value: 1 }],
      strict: true,
    };
    const binding: GraphBinding = {
      id: "agent",
      version: "1",
      kind: "agent",
      agent: new Agent({ name: "fixture", model: provider, tools: [approved.tool], maxTokens: 32, register: false }),
      tools: ["read"],
      input: z.object({}),
      output: z.object({}),
    };
    const clone = {
      ...approved,
      tool: {
        ...approved.tool,
        sandbox: structuredClone(approved.tool.sandbox),
        rawJsonSchema: structuredClone(approved.tool.rawJsonSchema),
        inputExamples: structuredClone(approved.tool.inputExamples),
      },
    };
    expect(validateExecutionPlan(plan(), [clone, binding], limits).order).toHaveLength(2);
    for (const changed of [
      { ...clone.tool, sandbox: { allowNetwork: true, allowFS: { readOnly: ["/repo"] } } },
      { ...clone.tool, rawJsonSchema: { type: "string" } },
      { ...clone.tool, inputExamples: [{ value: 2 }] },
      { ...clone.tool, strict: false },
      { ...clone.tool, description: "different" },
    ])
      invalid(plan(), [{ ...clone, tool: changed }, binding]);
  });
  it("pins concrete sandbox/schema/example/description contracts without persisting environment secrets", () => {
    const base = tool();
    const sandboxed = {
      ...base,
      tool: { ...base.tool, sandbox: { allowNetwork: false, env: { API_KEY: "fixture-secret" } } },
    };
    expect(graphCatalogDescriptor([sandboxed], limits)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: expect.objectContaining({
            sandbox: { allowNetwork: false, env: { API_KEY: expect.stringMatching(/^sha256:/) } },
          }),
        }),
      ]),
    );
    expect(JSON.stringify(graphCatalogDescriptor([sandboxed], limits))).not.toContain("fixture-secret");
    const digest = graphCatalogDigest([base], limits);
    for (const changed of [
      { ...base.tool, sandbox: { allowNetwork: true } },
      { ...base.tool, rawJsonSchema: { type: "object" } },
      { ...base.tool, inputExamples: [{ value: 1 }] },
      { ...base.tool, strict: true },
      { ...base.tool, description: "different" },
    ])
      expect(graphCatalogDigest([{ ...base, tool: changed }], limits)).not.toBe(digest);
    expect(graphCatalogDigest([sandboxed], limits)).not.toBe(
      graphCatalogDigest(
        [
          {
            ...sandboxed,
            tool: { ...sandboxed.tool, sandbox: { allowNetwork: false, env: { API_KEY: "new-secret" } } },
          },
        ],
        limits,
      ),
    );
  });
  it("rejects Agent recovery with dynamic instructions or unbounded model output before admission", () => {
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "fixture",
      generate: async () => {
        throw new Error("must not generate");
      },
      stream() {
        throw new Error("must not stream");
      },
    };
    for (const agent of [
      new Agent({ name: "unbounded", model: provider, register: false }),
      new Agent({ name: "dynamic", model: provider, instructions: () => "changing", maxTokens: 32, register: false }),
    ]) {
      const binding: GraphBinding = {
        id: "agent",
        version: "1",
        kind: "agent",
        agent,
        tools: [],
        input: z.object({}),
        output: z.object({}),
      };
      invalid(plan(), [tool(), binding]);
    }
  });
  it("bounds malformed root proposals before invoking nested catalog input validators", () => {
    let called = 0;
    const leaf = {
      ...tool(),
      input: {
        parse(value: unknown) {
          called++;
          return z.object({ value: z.number() }).parse(value);
        },
      },
    };
    const nested: GraphBinding = {
      id: "nested",
      version: "1",
      kind: "graph",
      input: z.object({}),
      output: z.object({}),
      program: { id: "child", version: "1", plan: { schemaVersion: 1, revision: 1, nodes: [plan().nodes[1]] } },
    };
    invalid(
      { ...plan(), nodes: [{ ...plan().nodes[1], args: { value: 4, padding: "x".repeat(1000) } }] },
      [leaf, nested],
      { maxBytes: 500 },
    );
    expect(called).toBe(0);
  });
  it("uses portable code-unit catalog ordering rather than locale-sensitive ordering", () => {
    expect(graphCatalogDescriptor([tool("ä"), tool("z")], limits)).toEqual([
      expect.objectContaining({ id: "z" }),
      expect.objectContaining({ id: "ä" }),
    ]);
  });
  it("catalog digest changes with operation version, schema, reference paths, and recovery identity but not declaration order", () => {
    expect(graphCatalogDigest([tool("a"), tool("b")], limits)).toBe(graphCatalogDigest([tool("b"), tool("a")], limits));
    const base = graphCatalogDigest([tool()], limits);
    for (const binding of [
      { ...tool(), version: "2" },
      { ...tool(), referenceOutputs: ["different"] },
      { ...tool(), tool: { ...tool().tool, parameters: z.object({ value: z.string() }) } },
    ])
      expect(graphCatalogDigest([binding], limits)).not.toBe(base);
    expect(graphCatalogDescriptor([tool()], limits)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "read", version: "1", kind: "tool" })]),
    );
  });
});

describe("concrete output references", () => {
  it("resolves JSON values and clones producer output without mutating recorded evidence", () => {
    const node = {
      ...plan().nodes[0],
      args: { payload: { nested: { $ref: { node: "producer", path: [] } } }, value: 3 },
    };
    const output: DurableJSON = { answer: 8 };
    const args = resolvePlanArguments(node, new Map([["producer", output]]));
    expect(args).toEqual({ payload: { nested: { answer: 8 } }, value: 3 });
    expect(args.payload).not.toBe(output);
  });
  it("rejects unavailable outputs and absent or inherited paths before effect intent", () => {
    expect(() => resolvePlanArguments(plan().nodes[0], new Map())).toThrow(ExecutionPlanValidationError);
    expect(() => resolvePlanArguments(plan().nodes[0], new Map([["producer", {}]]))).toThrow(
      ExecutionPlanValidationError,
    );
    const node = { ...plan().nodes[0], args: { value: { $ref: { node: "producer", path: ["constructor"] } } } };
    expect(() => resolvePlanArguments(node, new Map([["producer", {}]]))).toThrow(ExecutionPlanValidationError);
  });
});
