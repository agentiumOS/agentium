import { beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../../index.js";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { InMemoryVectorStore } from "../../../vector/in-memory.js";
import { LearnedKnowledge } from "../learned-knowledge.js";

/** Trivial deterministic embedder — every input maps to the same unit vector. */
const makeFlatEmbedder = (): EmbeddingProvider => ({
  dimensions: 3,
  supportsMultimodal: false,
  embed: async () => [1, 0, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
});

/**
 * Tests cover the v2.3.0 scope hierarchy:
 *   user   — only the saving user can read it back
 *   agent  — any user of that agent / role can read it
 *   tenant — any user/agent in the tenant can read it
 *   global — everyone can read it
 */
describe("LearnedKnowledge — scope hierarchy", () => {
  let storage: InMemoryStorage;
  let vector: InMemoryVectorStore;
  let kb: LearnedKnowledge;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vector = new InMemoryVectorStore(makeFlatEmbedder());
    kb = new LearnedKnowledge(vector, storage, { topK: 20 });
  });

  // Vector docs without an embedder need explicit embeddings — we side-load
  // them via upsert before the LearnedKnowledge save path.
  const save = async (opts: Parameters<LearnedKnowledge["saveLearning"]>[0]) => {
    return kb.saveLearning(opts);
  };

  it("defaults to user scope when scope is not provided", async () => {
    const l = await save({
      title: "Personal preference",
      content: "Prefer markdown",
      context: "writing",
      tags: [],
      namespace: "default",
      userId: "alice",
    });
    expect(l.scope).toBe("user");
  });

  it("user-scoped learning is invisible to a different user", async () => {
    await save({
      title: "Alice fact",
      content: "Alice likes coffee",
      context: "personal",
      tags: [],
      namespace: "default",
      userId: "alice",
    });
    const bobView = await kb.searchLearnings("coffee", { userId: "bob" });
    expect(bobView).toHaveLength(0);
  });

  it("user-scoped learning is visible to the saving user", async () => {
    await save({
      title: "Alice fact",
      content: "Alice likes coffee",
      context: "personal",
      tags: [],
      namespace: "default",
      userId: "alice",
    });
    const aliceView = await kb.searchLearnings("coffee", { userId: "alice" });
    expect(aliceView).toHaveLength(1);
  });

  it("agent-scoped learning is visible to ANY user of that agent", async () => {
    await save({
      title: "Invoice reconciliation tip",
      content: "Vendor X always has line-item drift",
      context: "invoice processing",
      tags: ["finance"],
      namespace: "default",
      scope: "agent",
      agentName: "invoice-recon",
    });

    // Alice and Bob both use the invoice-recon agent
    const aliceView = await kb.searchLearnings("line-item drift", {
      userId: "alice",
      agentName: "invoice-recon",
    });
    const bobView = await kb.searchLearnings("line-item drift", {
      userId: "bob",
      agentName: "invoice-recon",
    });
    expect(aliceView).toHaveLength(1);
    expect(bobView).toHaveLength(1);
  });

  it("agent-scoped learning is INVISIBLE to users of a different agent", async () => {
    await save({
      title: "Invoice tip",
      content: "Vendor X drifts",
      context: "invoice",
      tags: [],
      namespace: "default",
      scope: "agent",
      agentName: "invoice-recon",
    });

    const hrView = await kb.searchLearnings("Vendor X", {
      userId: "alice",
      agentName: "hr-agent",
    });
    expect(hrView).toHaveLength(0);
  });

  it("tenant-scoped learning is visible to any user/agent in the tenant", async () => {
    await save({
      title: "Org policy",
      content: "Refunds over $500 require VP sign-off",
      context: "refund approval",
      tags: ["policy"],
      namespace: "default",
      scope: "tenant",
      tenantId: "acme-corp",
    });

    const sameTenant = await kb.searchLearnings("VP sign-off", {
      userId: "alice",
      agentName: "support",
      tenantId: "acme-corp",
    });
    const otherTenant = await kb.searchLearnings("VP sign-off", {
      userId: "bob",
      agentName: "support",
      tenantId: "meridian-llc",
    });
    expect(sameTenant).toHaveLength(1);
    expect(otherTenant).toHaveLength(0);
  });

  it("global-scoped learning is visible to everyone", async () => {
    await save({
      title: "Universal tip",
      content: "Always verify the order before refunding",
      context: "refunds",
      tags: [],
      namespace: "default",
      scope: "global",
    });

    const someone = await kb.searchLearnings("verify the order", {
      userId: "anyone",
    });
    expect(someone).toHaveLength(1);
  });

  it("searchLearnings unions all accessible scopes", async () => {
    await save({
      title: "Alice's pref",
      content: "Alice prefers markdown",
      context: "writing",
      tags: [],
      namespace: "default",
      scope: "user",
      userId: "alice",
    });
    await save({
      title: "Team workflow",
      content: "Invoice recon: lookup_po then diff",
      context: "invoice",
      tags: [],
      namespace: "default",
      scope: "agent",
      agentName: "invoice-recon",
    });
    await save({
      title: "Org policy",
      content: "Refunds >$500 need VP",
      context: "refund",
      tags: [],
      namespace: "default",
      scope: "tenant",
      tenantId: "acme",
    });

    const aliceFullView = await kb.searchLearnings("preference workflow policy", {
      topK: 10,
      userId: "alice",
      agentName: "invoice-recon",
      tenantId: "acme",
    });
    // She sees personal + agent-shared + tenant-shared
    expect(aliceFullView).toHaveLength(3);
  });

  it("getContextString returns nothing when no scope identifiers are provided", async () => {
    await save({
      title: "x",
      content: "y",
      context: "z",
      tags: [],
      namespace: "default",
      scope: "global",
    });
    const ctx = await kb.getContextString("anything", {});
    expect(ctx).toBe("");
  });

  it("getContextString tags agent/tenant scope visibly", async () => {
    await save({
      title: "Team workflow",
      content: "Invoice recon steps",
      context: "invoice",
      tags: [],
      namespace: "default",
      scope: "agent",
      agentName: "invoice-recon",
    });
    const ctx = await kb.getContextString("invoice", {
      userId: "alice",
      agentName: "invoice-recon",
    });
    expect(ctx).toContain("[agent]");
    expect(ctx).toContain("Team workflow");
  });

  it("saving with scope='agent' but no agentName throws", async () => {
    await expect(
      save({
        title: "x",
        content: "y",
        context: "z",
        tags: [],
        namespace: "default",
        scope: "agent",
      }),
    ).rejects.toThrow(/agentName/i);
  });

  it("legacy data without scope is treated as user-scoped", async () => {
    // Bypass saveLearning so we don't get a default applied — simulate pre-v2.3 data.
    const id = "legacy-1";
    const legacy = {
      id,
      title: "Legacy fact",
      content: "Some old content",
      context: "",
      tags: [],
      namespace: "default",
      userId: "alice",
      createdAt: new Date(),
      // intentionally no `scope`
    };
    await vector.upsert("agentium_learnings", {
      id,
      content: `${legacy.title}: ${legacy.content}`,
      embedding: [1, 0, 0],
    });
    await storage.set("memory:learnings", id, legacy);

    const aliceView = await kb.searchLearnings("legacy", { userId: "alice" });
    expect(aliceView).toHaveLength(1);

    const bobView = await kb.searchLearnings("legacy", { userId: "bob" });
    expect(bobView).toHaveLength(0);
  });
});
