import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../index.js";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { InMemoryVectorStore } from "../../../vector/in-memory.js";
import { CorrectionStore } from "../correction-store.js";

/** Trivial deterministic embedder — every input maps to the same unit vector. */
const makeFlatEmbedder = (): EmbeddingProvider => ({
  dimensions: 3,
  supportsMultimodal: false,
  embed: async () => [1, 0, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0, 0]),
});

describe("CorrectionStore", () => {
  let storage: InMemoryStorage;
  let vector: InMemoryVectorStore;
  let store: CorrectionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    vector = new InMemoryVectorStore(makeFlatEmbedder());
    store = new CorrectionStore(vector, storage, { topK: 20 });
  });

  it("records a correction with agent scope by default", async () => {
    const c = await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "THC",
      correctedValue: "DTHC",
      reason: "Vendor X labels destination THC as just THC",
      entityKey: "vendor-x",
    });

    expect(c.id).toBeTruthy();
    expect(c.scope).toBe("agent");
    expect(c.createdAt).toBeInstanceOf(Date);
  });

  it("requires agentName, originalValue, and correctedValue", async () => {
    await expect(store.recordCorrection({ agentName: "", originalValue: "a", correctedValue: "b" })).rejects.toThrow(
      "agentName",
    );
    await expect(store.recordCorrection({ agentName: "x", originalValue: "", correctedValue: "b" })).rejects.toThrow(
      "originalValue",
    );
  });

  it("enforces scope identifiers (user scope requires userId)", async () => {
    await expect(
      store.recordCorrection({
        agentName: "ap-reconciler",
        originalValue: "a",
        correctedValue: "b",
        scope: "user",
      }),
    ).rejects.toThrow("userId");
  });

  it("agent-scoped correction is visible to any user of that agent", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "THC",
      correctedValue: "DTHC",
      entityKey: "vendor-x",
    });

    const aliceView = await store.searchCorrections("THC", {
      userId: "alice",
      agentName: "ap-reconciler",
    });
    const bobView = await store.searchCorrections("THC", {
      userId: "bob",
      agentName: "ap-reconciler",
    });
    expect(aliceView).toHaveLength(1);
    expect(bobView).toHaveLength(1);
  });

  it("agent-scoped correction is invisible to a different agent", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "THC",
      correctedValue: "DTHC",
    });

    const otherAgentView = await store.searchCorrections("THC", {
      userId: "alice",
      agentName: "customs-filer",
    });
    expect(otherAgentView).toHaveLength(0);
  });

  it("filters search by entityKey", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "THC",
      correctedValue: "DTHC",
      entityKey: "vendor-x",
    });
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "BAF",
      correctedValue: "FAF",
      entityKey: "vendor-y",
    });

    const vendorX = await store.searchCorrections("charge", {
      agentName: "ap-reconciler",
      entityKey: "vendor-x",
    });
    expect(vendorX).toHaveLength(1);
    expect(vendorX[0].correctedValue).toBe("DTHC");
  });

  it("deletes a correction from both vector and KV storage", async () => {
    const c = await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "a",
      correctedValue: "b",
    });
    await store.deleteCorrection(c.id);
    expect(await store.getCorrection(c.id)).toBeNull();
    const results = await store.searchCorrections("a", { agentName: "ap-reconciler" });
    expect(results).toHaveLength(0);
  });

  it("lists corrections filtered by agentName and entityKey", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "a",
      correctedValue: "b",
      entityKey: "vendor-x",
    });
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "c",
      correctedValue: "d",
      entityKey: "vendor-y",
    });
    await store.recordCorrection({
      agentName: "customs-filer",
      originalValue: "e",
      correctedValue: "f",
    });

    expect(await store.listCorrections({ agentName: "ap-reconciler" })).toHaveLength(2);
    expect(await store.listCorrections({ entityKey: "vendor-x" })).toHaveLength(1);
    expect(await store.listCorrections()).toHaveLength(3);
  });

  it("computes stats grouped by entityKey and field", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "a",
      correctedValue: "b",
      entityKey: "vendor-x",
    });
    await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "c",
      correctedValue: "d",
      entityKey: "vendor-x",
    });
    await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "amount",
      originalValue: "e",
      correctedValue: "f",
      entityKey: "vendor-y",
    });

    const stats = await store.getStats({ agentName: "ap-reconciler" });
    expect(stats.total).toBe(3);
    expect(stats.byEntityKey["vendor-x"]).toBe(2);
    expect(stats.byEntityKey["vendor-y"]).toBe(1);
    expect(stats.byField.chargeCode).toBe(2);
    expect(stats.byField.amount).toBe(1);
  });

  it("builds a context string with past corrections", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      field: "chargeCode",
      originalValue: "THC",
      correctedValue: "DTHC",
      reason: "Vendor X convention",
      entityKey: "vendor-x",
    });

    const ctx = await store.getContextString("reconcile vendor-x invoice", {
      agentName: "ap-reconciler",
    });
    expect(ctx).toContain("Past corrections");
    expect(ctx).toContain('"THC" was corrected to "DTHC"');
    expect(ctx).toContain("vendor-x");
    expect(ctx).toContain("Vendor X convention");
  });

  it("refuses to build context without any scope identifier", async () => {
    await store.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "a",
      correctedValue: "b",
    });
    const ctx = await store.getContextString("anything", {});
    expect(ctx).toBe("");
  });

  it("invokes onRecorded callback for event emission", async () => {
    const onRecorded = vi.fn();
    const eventedStore = new CorrectionStore(vector, storage, { onRecorded });
    await eventedStore.recordCorrection({
      agentName: "ap-reconciler",
      originalValue: "a",
      correctedValue: "b",
    });
    expect(onRecorded).toHaveBeenCalledOnce();
    expect(onRecorded.mock.calls[0][0].agentName).toBe("ap-reconciler");
  });

  it("exposes record_correction and search_corrections tools", async () => {
    const tools = store.getTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("record_correction");
    expect(names).toContain("search_corrections");

    const recordTool = tools.find((t) => t.name === "record_correction")!;
    const result = await recordTool.execute(
      { originalValue: "THC", correctedValue: "DTHC", field: "chargeCode", entityKey: "vendor-x" },
      { userId: "alice", sessionId: "s1", metadata: { agentName: "ap-reconciler" } } as any,
    );
    expect(result).toContain("Correction recorded");

    const searchTool = tools.find((t) => t.name === "search_corrections")!;
    const found = await searchTool.execute({ query: "THC" }, {
      userId: "alice",
      metadata: { agentName: "ap-reconciler" },
    } as any);
    expect(found).toContain("DTHC");
  });
});
