import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../../events/event-bus.js";
import type { EmbeddingProvider } from "../../../index.js";
import type { ModelProvider } from "../../../models/provider.js";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { InMemoryVectorStore } from "../../../vector/in-memory.js";
import { MemoryManager } from "../../memory-manager.js";
import { CorrectionStore } from "../correction-store.js";
import { LearnedKnowledge } from "../learned-knowledge.js";

/** Every input maps to the same unit vector — all similarities are 1.0. */
const makeFlatEmbedder = (): EmbeddingProvider => ({
  dimensions: 3,
  supportsMultimodal: false,
  embed: async () => [1, 0, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
});

/** Texts containing "vendor" map to one axis, everything else to another. */
const makeDirectionalEmbedder = (): EmbeddingProvider => ({
  dimensions: 3,
  supportsMultimodal: false,
  embed: async (text) => (text.toLowerCase().includes("vendor") ? [1, 0, 0] : [0, 1, 0]),
  embedBatch: async (texts) => texts.map((t) => (t.toLowerCase().includes("vendor") ? [1, 0, 0] : [0, 1, 0])),
});

const mockExtractionModel = (response: string): ModelProvider => ({
  providerId: "test",
  modelId: "test-model",
  generate: vi.fn().mockResolvedValue({
    message: { role: "assistant", content: response },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop",
    raw: {},
  }),
  stream: vi.fn(),
});

describe("LearnedKnowledge — provenance and trust", () => {
  let storage: InMemoryStorage;
  let vector: InMemoryVectorStore;
  let kb: LearnedKnowledge;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vector = new InMemoryVectorStore(makeFlatEmbedder());
    kb = new LearnedKnowledge(vector, storage, { topK: 20 });
  });

  it("renders trust markers and an unverified caveat in context", async () => {
    await kb.saveLearning({
      title: "Verified rule",
      content: "Always use DTHC for vendor X",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      source: "manual",
      userId: "alice",
    });
    await kb.saveLearning({
      title: "AI hypothesis",
      content: "Vendor X might prefer email",
      context: "communication",
      tags: [],
      namespace: "default",
      source: "llm-extracted",
      userId: "alice",
    });

    const ctx = await kb.getContextString("vendor X", { userId: "alice" });
    expect(ctx).toContain("[verified]");
    expect(ctx).toContain("[unverified]");
    expect(ctx).toContain("AI-extracted hypotheses");
  });

  it("omits the caveat when all learnings are verified", async () => {
    await kb.saveLearning({
      title: "Verified rule",
      content: "Always use DTHC",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      source: "human-correction",
      userId: "alice",
    });

    const ctx = await kb.getContextString("DTHC", { userId: "alice" });
    expect(ctx).toContain("[verified]");
    expect(ctx).not.toContain("AI-extracted hypotheses");
  });

  it("invalidated learnings are excluded from search but kept in KV for audit", async () => {
    const l = await kb.saveLearning({
      title: "Stale rule",
      content: "Use THC code",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      source: "llm-extracted",
      userId: "alice",
    });

    await kb.invalidateLearning(l.id, "correction-123");

    const results = await kb.searchLearnings("THC", { userId: "alice" });
    expect(results).toHaveLength(0);

    const audit = await kb.getLearning(l.id);
    expect(audit).not.toBeNull();
    expect(audit!.invalidatedAt).toBeTruthy();
    expect(audit!.supersededBy).toBe("correction-123");
  });

  it("invalidateContradicted only retires llm-extracted learnings, never human-authored", async () => {
    const aiLearning = await kb.saveLearning({
      title: "AI guess",
      content: "Vendor X uses THC",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      scope: "agent",
      source: "llm-extracted",
      agentName: "ap-reconciler",
    });
    const humanLearning = await kb.saveLearning({
      title: "Human note",
      content: "Vendor X invoices arrive monthly",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      scope: "agent",
      source: "manual",
      agentName: "ap-reconciler",
    });

    const invalidated = await kb.invalidateContradicted("Vendor X charge codes", {
      supersededBy: "corr-1",
      agentName: "ap-reconciler",
    });

    expect(invalidated).toEqual([aiLearning.id]);
    expect((await kb.getLearning(aiLearning.id))!.invalidatedAt).toBeTruthy();
    expect((await kb.getLearning(humanLearning.id))!.invalidatedAt).toBeUndefined();
  });

  it("reconcile re-indexes KV learnings missing from the vector store", async () => {
    const l = await kb.saveLearning({
      title: "Rule",
      content: "Use DTHC",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      source: "manual",
      userId: "alice",
    });

    // Simulate dual-write drift: vector entry lost, KV intact.
    await vector.delete("agentium_learnings", l.id);
    expect(await kb.searchLearnings("DTHC", { userId: "alice" })).toHaveLength(0);

    const repaired = await kb.reconcile();
    expect(repaired).toBe(1);
    expect(await kb.searchLearnings("DTHC", { userId: "alice" })).toHaveLength(1);
  });

  it("minScore filters weak matches out of retrieval", async () => {
    const directionalVector = new InMemoryVectorStore(makeDirectionalEmbedder());
    const scopedKb = new LearnedKnowledge(directionalVector, storage, { topK: 20, minScore: 0.5 });

    await scopedKb.saveLearning({
      title: "Vendor rule",
      content: "vendor X uses DTHC",
      context: "vendor reconciliation",
      tags: [],
      namespace: "default",
      source: "manual",
      userId: "alice",
    });
    await scopedKb.saveLearning({
      title: "Unrelated",
      content: "office closes at 6pm",
      context: "logistics",
      tags: [],
      namespace: "default",
      source: "manual",
      userId: "alice",
    });

    // Query embeds on the "vendor" axis — the unrelated learning scores 0.
    const results = await scopedKb.searchLearnings("vendor charge codes", { userId: "alice" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Vendor rule");
  });
});

describe("LearnedKnowledge — pruning", () => {
  let storage: InMemoryStorage;
  let kb: LearnedKnowledge;

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  };

  /** Save a learning then backdate its createdAt in KV storage. */
  const saveAged = async (opts: Parameters<LearnedKnowledge["saveLearning"]>[0], ageDays: number) => {
    const l = await kb.saveLearning(opts);
    await storage.set("memory:learnings", l.id, { ...l, createdAt: daysAgo(ageDays) });
    return l;
  };

  beforeEach(() => {
    storage = new InMemoryStorage();
    kb = new LearnedKnowledge(new InMemoryVectorStore(makeFlatEmbedder()), storage, { topK: 20 });
  });

  it("age-prunes only llm-extracted learnings by default", async () => {
    const oldAi = await saveAged(
      {
        title: "Old AI guess",
        content: "x",
        context: "",
        tags: [],
        namespace: "d",
        scope: "agent",
        source: "llm-extracted",
        agentName: "bot",
      },
      120,
    );
    const oldHuman = await saveAged(
      {
        title: "Old human rule",
        content: "y",
        context: "",
        tags: [],
        namespace: "d",
        scope: "agent",
        source: "manual",
        agentName: "bot",
      },
      120,
    );
    const freshAi = await saveAged(
      {
        title: "Fresh AI guess",
        content: "z",
        context: "",
        tags: [],
        namespace: "d",
        scope: "agent",
        source: "llm-extracted",
        agentName: "bot",
      },
      5,
    );

    const pruned = await kb.pruneLearnings({ maxAgeDays: 90, agentName: "bot" });

    expect(pruned).toBe(1);
    expect(await kb.getLearning(oldAi.id)).toBeNull();
    expect(await kb.getLearning(oldHuman.id)).not.toBeNull();
    expect(await kb.getLearning(freshAi.id)).not.toBeNull();
  });

  it("keeps untagged (pre-v2.5) learnings unless includeUntagged is set", async () => {
    const untagged = await saveAged(
      { title: "Legacy", content: "x", context: "", tags: [], namespace: "d", scope: "agent", agentName: "bot" },
      120,
    );

    expect(await kb.pruneLearnings({ maxAgeDays: 90, agentName: "bot" })).toBe(0);
    expect(await kb.getLearning(untagged.id)).not.toBeNull();

    expect(await kb.pruneLearnings({ maxAgeDays: 90, agentName: "bot", includeUntagged: true })).toBe(1);
    expect(await kb.getLearning(untagged.id)).toBeNull();
  });

  it("purges old invalidated learnings regardless of source", async () => {
    const l = await saveAged(
      {
        title: "Superseded human note",
        content: "x",
        context: "",
        tags: [],
        namespace: "d",
        scope: "agent",
        source: "manual",
        agentName: "bot",
      },
      120,
    );
    await kb.invalidateLearning(l.id, "corr-1");
    // invalidateLearning refreshes the record — re-backdate createdAt
    const record = await kb.getLearning(l.id);
    await storage.set("memory:learnings", l.id, { ...record!, createdAt: daysAgo(120) });

    const pruned = await kb.pruneLearnings({ maxAgeDays: 90, agentName: "bot" });
    expect(pruned).toBe(1);
    expect(await kb.getLearning(l.id)).toBeNull();
  });

  it("respects the agentName owner filter", async () => {
    const otherAgent = await saveAged(
      {
        title: "Other agent's AI guess",
        content: "x",
        context: "",
        tags: [],
        namespace: "d",
        scope: "agent",
        source: "llm-extracted",
        agentName: "other-bot",
      },
      120,
    );

    expect(await kb.pruneLearnings({ maxAgeDays: 90, agentName: "bot" })).toBe(0);
    expect(await kb.getLearning(otherAgent.id)).not.toBeNull();
  });
});

describe("LearnedKnowledge — grounded extraction", () => {
  let storage: InMemoryStorage;
  let kb: LearnedKnowledge;

  beforeEach(() => {
    storage = new InMemoryStorage();
    kb = new LearnedKnowledge(new InMemoryVectorStore(makeFlatEmbedder()), storage, { topK: 20 });
  });

  const conversation = [
    { role: "user" as const, content: "Vendor X always labels destination THC as just THC on invoices." },
    { role: "assistant" as const, content: "Noted — I'll map THC to DTHC for Vendor X going forward." },
  ];

  it("saves extractions anchored to a verbatim quote", async () => {
    const model = mockExtractionModel(
      JSON.stringify([
        {
          title: "Vendor X THC labeling",
          content: "Vendor X labels destination THC as just THC",
          context: "invoice reconciliation",
          tags: [],
          evidence: "Vendor X always labels destination THC as just THC",
        },
      ]),
    );

    await kb.extractLearnings(conversation, model, "alice");
    const results = await kb.searchLearnings("THC", { userId: "alice" });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("llm-extracted");
    expect(results[0].evidence).toContain("Vendor X always labels");
  });

  it("rejects extractions with fabricated or missing evidence", async () => {
    const model = mockExtractionModel(
      JSON.stringify([
        {
          title: "Fabricated insight",
          content: "Vendor X prefers wire transfers",
          context: "payments",
          tags: [],
          evidence: "Vendor X said they prefer wire transfers", // not in conversation
        },
        {
          title: "Missing evidence",
          content: "Vendor X ships weekly",
          context: "logistics",
          tags: [],
          // no evidence field at all
        },
      ]),
    );

    await kb.extractLearnings(conversation, model, "alice");
    const results = await kb.searchLearnings("Vendor X", { userId: "alice" });
    expect(results).toHaveLength(0);
  });
});

describe("MemoryManager — correction-driven self-correction", () => {
  it("recording a correction invalidates contradicted unverified learnings and emits an event", async () => {
    const storage = new InMemoryStorage();
    const vectorStore = new InMemoryVectorStore(makeFlatEmbedder());
    const eventBus = new EventBus();
    const invalidatedEvents: unknown[] = [];
    eventBus.on("memory.learning.invalidated", (e) => invalidatedEvents.push(e));

    const mm = new MemoryManager({
      storage,
      summaries: false,
      learnings: { vectorStore, topK: 20 },
      corrections: { vectorStore: new InMemoryVectorStore(makeFlatEmbedder()) },
      eventBus,
    });

    const kb = mm.getLearnedKnowledge()!;
    const aiLearning = await kb.saveLearning({
      title: "AI guess",
      content: "Vendor X uses THC code",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      scope: "agent",
      source: "llm-extracted",
      agentName: "ap-reconciler",
    });

    await mm.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "THC",
      correctedValue: "DTHC",
      reason: "Vendor X convention",
    });

    expect((await kb.getLearning(aiLearning.id))!.invalidatedAt).toBeTruthy();
    expect(invalidatedEvents).toHaveLength(1);
    expect((invalidatedEvents[0] as any).learningIds).toEqual([aiLearning.id]);
  });

  it("respects invalidateContradicted: false", async () => {
    const storage = new InMemoryStorage();
    const vectorStore = new InMemoryVectorStore(makeFlatEmbedder());

    const mm = new MemoryManager({
      storage,
      summaries: false,
      learnings: { vectorStore, topK: 20 },
      corrections: {
        vectorStore: new InMemoryVectorStore(makeFlatEmbedder()),
        invalidateContradicted: false,
      },
    });

    const kb = mm.getLearnedKnowledge()!;
    const aiLearning = await kb.saveLearning({
      title: "AI guess",
      content: "Vendor X uses THC code",
      context: "reconciliation",
      tags: [],
      namespace: "default",
      scope: "agent",
      source: "llm-extracted",
      agentName: "ap-reconciler",
    });

    await mm.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "THC",
      correctedValue: "DTHC",
    });

    expect((await kb.getLearning(aiLearning.id))!.invalidatedAt).toBeUndefined();
  });
});

describe("CorrectionStore — regression evals and reconcile", () => {
  let storage: InMemoryStorage;
  let vector: InMemoryVectorStore;
  let store: CorrectionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vector = new InMemoryVectorStore(makeFlatEmbedder());
    store = new CorrectionStore(vector, storage, { topK: 20 });
  });

  it("toEvalCases maps corrections with originalInput into replayable cases", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "THC",
      correctedValue: "DTHC",
      originalInput: "Reconcile invoice INV-99 from Vendor X",
      entityKey: "vendor-x",
    });
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "a",
      correctedValue: "b",
      // no originalInput — not replayable
    });

    const cases = await store.toEvalCases({ agentName: "ap-reconciler" });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      input: "Reconcile invoice INV-99 from Vendor X",
      expected: "DTHC",
      field: "chargeCode",
    });
  });

  it("reconcile re-indexes KV corrections missing from the vector store", async () => {
    const c = await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "THC",
      correctedValue: "DTHC",
    });

    await vector.delete("agentium_corrections", c.id);
    expect(await store.searchCorrections("THC", { agentName: "ap-reconciler" })).toHaveLength(0);

    const repaired = await store.reconcile();
    expect(repaired).toBe(1);
    expect(await store.searchCorrections("THC", { agentName: "ap-reconciler" })).toHaveLength(1);
  });
});
