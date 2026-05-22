import { beforeEach, describe, expect, it } from "vitest";
import { classifyServables, Registry, registry } from "../serve.js";

describe("classifyServables", () => {
  it("classifies agents, teams, and workflows", () => {
    const agent = { kind: "agent", name: "bot" };
    const team = { kind: "team", name: "squad" };
    const workflow = { kind: "workflow", name: "pipeline" };

    const result = classifyServables([agent, team, workflow] as any[]);

    expect(result.agents).toHaveProperty("bot");
    expect(result.teams).toHaveProperty("squad");
    expect(result.workflows).toHaveProperty("pipeline");
    expect(result.agents.bot).toBe(agent);
    expect(result.teams.squad).toBe(team);
    expect(result.workflows.pipeline).toBe(workflow);
  });

  it("classifies multiple agents", () => {
    const a1 = { kind: "agent", name: "alpha" };
    const a2 = { kind: "agent", name: "beta" };

    const result = classifyServables([a1, a2] as any[]);

    expect(Object.keys(result.agents)).toHaveLength(2);
    expect(result.agents.alpha).toBe(a1);
    expect(result.agents.beta).toBe(a2);
  });

  it("returns empty maps for empty input", () => {
    const result = classifyServables([]);
    expect(result.agents).toEqual({});
    expect(result.teams).toEqual({});
    expect(result.workflows).toEqual({});
  });

  it("throws on duplicate agent names", () => {
    const a1 = { kind: "agent", name: "dup" };
    const a2 = { kind: "agent", name: "dup" };

    expect(() => classifyServables([a1, a2] as any[])).toThrow("Duplicate agent");
  });

  it("throws on duplicate team names", () => {
    const t1 = { kind: "team", name: "dup" };
    const t2 = { kind: "team", name: "dup" };

    expect(() => classifyServables([t1, t2] as any[])).toThrow("Duplicate team");
  });

  it("throws on unknown kind", () => {
    const unknown = { kind: "llm", name: "foo" };
    expect(() => classifyServables([unknown] as any[])).toThrow("Unknown servable kind");
  });

  it("throws when name is missing", () => {
    const noName = { kind: "agent" };
    expect(() => classifyServables([noName] as any[])).toThrow("missing");
  });

  it("allows same name across different kinds", () => {
    const agent = { kind: "agent", name: "shared" };
    const team = { kind: "team", name: "shared" };

    const result = classifyServables([agent, team] as any[]);
    expect(result.agents).toHaveProperty("shared");
    expect(result.teams).toHaveProperty("shared");
  });
});

describe("Registry", () => {
  let reg: Registry;

  beforeEach(() => {
    reg = new Registry();
  });

  it("adds and retrieves agents", () => {
    const agent = { kind: "agent", name: "bot" } as any;
    reg.add(agent);
    expect(reg.getAgent("bot")).toBe(agent);
  });

  it("adds and retrieves teams", () => {
    const team = { kind: "team", name: "squad" } as any;
    reg.add(team);
    expect(reg.getTeam("squad")).toBe(team);
  });

  it("adds and retrieves workflows", () => {
    const wf = { kind: "workflow", name: "pipe" } as any;
    reg.add(wf);
    expect(reg.getWorkflow("pipe")).toBe(wf);
  });

  it("returns undefined for missing entries", () => {
    expect(reg.getAgent("nope")).toBeUndefined();
    expect(reg.getTeam("nope")).toBeUndefined();
    expect(reg.getWorkflow("nope")).toBeUndefined();
  });

  it("removes items", () => {
    const agent = { kind: "agent", name: "bot" } as any;
    reg.add(agent);
    expect(reg.remove(agent)).toBe(true);
    expect(reg.getAgent("bot")).toBeUndefined();
  });

  it("throws on duplicate agent names", () => {
    const a1 = { kind: "agent", name: "bot", v: 1 } as any;
    const a2 = { kind: "agent", name: "bot", v: 2 } as any;
    reg.add(a1);
    expect(() => reg.add(a2)).toThrow("Duplicate agent name");
  });

  it("throws on duplicate team names", () => {
    const t1 = { kind: "team", name: "squad" } as any;
    const t2 = { kind: "team", name: "squad" } as any;
    reg.add(t1);
    expect(() => reg.add(t2)).toThrow("Duplicate team name");
  });

  it("throws on duplicate workflow names", () => {
    const w1 = { kind: "workflow", name: "pipe" } as any;
    const w2 = { kind: "workflow", name: "pipe" } as any;
    reg.add(w1);
    expect(() => reg.add(w2)).toThrow("Duplicate workflow name");
  });

  it("lists all registered names", () => {
    reg.add({ kind: "agent", name: "a" } as any);
    reg.add({ kind: "agent", name: "b" } as any);
    reg.add({ kind: "team", name: "t" } as any);

    const list = reg.list();
    expect(list.agents).toEqual(["a", "b"]);
    expect(list.teams).toEqual(["t"]);
    expect(list.workflows).toEqual([]);
  });

  it("clears all entries", () => {
    reg.add({ kind: "agent", name: "a" } as any);
    reg.add({ kind: "team", name: "t" } as any);
    reg.clear();

    const list = reg.list();
    expect(list.agents).toEqual([]);
    expect(list.teams).toEqual([]);
  });

  it("describeAgents returns metadata", () => {
    reg.add({
      kind: "agent",
      name: "bot",
      modelId: "gpt-4o",
      providerId: "openai",
      tools: [{ name: "search" }, { name: "calc" }],
      hasStructuredOutput: true,
    } as any);

    const agents = reg.describeAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: "bot",
      model: "gpt-4o",
      provider: "openai",
      tools: ["search", "calc"],
      hasStructuredOutput: true,
    });
    expect(agents[0].capabilities).toContain("streaming");
  });

  it("describeTeams returns names", () => {
    reg.add({ kind: "team", name: "squad" } as any);
    expect(reg.describeTeams()).toEqual([{ name: "squad" }]);
  });

  it("describeWorkflows returns names", () => {
    reg.add({ kind: "workflow", name: "pipe" } as any);
    expect(reg.describeWorkflows()).toEqual([{ name: "pipe" }]);
  });
});

describe("global registry singleton", () => {
  beforeEach(() => {
    registry.clear();
  });

  it("is shared across imports", () => {
    expect(registry).toBeInstanceOf(Registry);
    registry.add({ kind: "agent", name: "global-test" } as any);
    expect(registry.getAgent("global-test")).toBeDefined();
  });
});
