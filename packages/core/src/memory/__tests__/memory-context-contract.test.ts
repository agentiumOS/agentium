import { describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "../../storage/in-memory.js";
import { countTokens } from "../../utils/token-counter.js";
import { InMemoryVectorStore } from "../../vector/in-memory.js";
import { MemoryManager } from "../memory-manager.js";

describe("memory source assembly and explicit writes", () => {
  it("retains source wrappers when every section fits the configured budget", async () => {
    const memory = new MemoryManager({
      storage: new InMemoryStorage(),
      summaries: false,
      userFacts: true,
      contextBudget: { maxTokens: 500 },
    });
    await memory.remember("Deployments require review", { userId: "u" });
    const context = await memory.buildContext("s", "u");
    expect(context).toContain('<memory section="userFacts"');
    expect(context).toContain('trust="source"');
    expect(context).toContain("Deployments require review");
    expect(context).toContain("</memory>");
    expect(countTokens(context)).toBeLessThanOrEqual(500);
  });

  it("omits whole sections when content fits but its source wrapper exceeds the budget", async () => {
    const memory = new MemoryManager({
      storage: new InMemoryStorage(),
      summaries: false,
      userFacts: true,
      contextBudget: { maxTokens: 70 },
    });
    const facts = memory.getUserFacts();
    if (!facts) throw new Error("missing fixture store");
    const content = `Rules:\n- ${"Deployments must remain blocked until human review. ".repeat(3)}`;
    expect(countTokens(content)).toBeLessThanOrEqual(70);
    vi.spyOn(facts, "getContextString").mockResolvedValue(content);
    expect(await memory.buildContext("s", "u")).toBe("");
  });

  it("never trims a correction or negation into a partial admitted section", async () => {
    const memory = new MemoryManager({
      storage: new InMemoryStorage(),
      summaries: false,
      userFacts: true,
      contextBudget: { maxTokens: 75 },
    });
    const facts = memory.getUserFacts();
    if (!facts) throw new Error("missing fixture store");
    vi.spyOn(facts, "getContextString").mockResolvedValue(
      `Rules:\n- ${"Do not approve deployments before review. ".repeat(20)}\n- Do not delete the audit trail.`,
    );
    expect(await memory.buildContext("s", "u")).toBe("");
  });

  it("counts separators, keeps stable priority order, and admits only complete sections", async () => {
    const storage = new InMemoryStorage();
    const full = new MemoryManager({ storage, summaries: false, userFacts: true, userProfile: true });
    const facts = full.getUserFacts();
    const profile = full.getUserProfile();
    if (!facts || !profile) throw new Error("missing fixture stores");
    await facts.addFacts("u", [{ fact: "Fact requiring review" }]);
    await profile.updateProfile("u", { name: "Profile owner" });
    const fullContext = await full.buildContext("s", "u");
    expect(fullContext.indexOf('section="userProfile"')).toBeLessThan(fullContext.indexOf('section="userFacts"'));
    const budget = countTokens(fullContext) - 1;
    const bounded = new MemoryManager({
      storage,
      summaries: false,
      userFacts: true,
      userProfile: true,
      contextBudget: { maxTokens: budget },
    });
    const context = await bounded.buildContext("s", "u");
    expect(countTokens(context)).toBeLessThanOrEqual(budget);
    expect(context).toContain("Profile owner");
    expect(context).not.toContain("Fact requiring review");
    expect(context).toContain("</memory>");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid configured memory token budget %s",
    (maxTokens) => {
      expect(() => new MemoryManager({ storage: new InMemoryStorage(), contextBudget: { maxTokens } })).toThrow(
        /positive safe integer/,
      );
    },
  );

  it("reports no destination while preserving remember's void no-op result", async () => {
    const memory = new MemoryManager({ storage: new InMemoryStorage(), summaries: false });
    expect(await memory.rememberWithResult("review required", { userId: "u" })).toEqual({
      stored: false,
      reason: "no_destination",
    });
    expect(await memory.remember("review required", { userId: "u" })).toBeUndefined();
  });

  it("uses user facts before learnings and entities and truthfully reports persistence", async () => {
    const vectorStore = new InMemoryVectorStore({
      dimensions: 3,
      supportsMultimodal: false,
      embed: async () => [1, 0, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
    });
    const memory = new MemoryManager({
      storage: new InMemoryStorage(),
      summaries: false,
      userFacts: true,
      learnings: { vectorStore },
      entities: true,
    });
    expect(await memory.rememberWithResult("review required", { userId: "u" })).toEqual({
      stored: true,
      destination: "user_facts",
    });
    expect((await memory.getUserFacts()?.getActiveFacts("u"))?.map((fact) => fact.fact)).toEqual(["review required"]);
    const learnings = new MemoryManager({
      storage: new InMemoryStorage(),
      summaries: false,
      learnings: { vectorStore },
      entities: true,
    });
    expect(await learnings.rememberWithResult("general rule", { userId: "u" })).toEqual({
      stored: true,
      destination: "learnings",
    });
    expect(
      (await learnings.recall("general rule", { userId: "u" })).some((result) =>
        result.content.includes("general rule"),
      ),
    ).toBe(true);
    await expect(learnings.rememberWithResult("unscoped learning")).rejects.toThrow("requires a userId");
    const entities = new MemoryManager({ storage: new InMemoryStorage(), summaries: false, entities: true });
    expect(await entities.rememberWithResult("entity fact", { userId: "u" })).toEqual({
      stored: true,
      destination: "entities",
    });
    expect((await entities.getEntityMemory()?.listEntities("u"))?.[0]?.facts?.[0]?.fact).toBe("entity fact");
    expect(await entities.rememberWithResult("unscoped entity fact")).toEqual({
      stored: false,
      reason: "no_destination",
    });
  });
});
