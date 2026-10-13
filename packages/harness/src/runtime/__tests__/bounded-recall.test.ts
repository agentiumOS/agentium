import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRecallUsage,
  openRecallCycle,
  type RecallSession,
  type RecallStore,
  validateRecallConfiguration,
} from "../recall.js";
import { continuityBudget, continuityScope, createContinuityFixture } from "./fixtures/continuity-fixture.js";

describe("bounded recall", () => {
  afterEach(() => vi.useRealTimers());
  it("seeks evidence by locator under physical source limits without full archive reads", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("large", [
      ...Array.from({ length: 10000 }, () => "unrelated"),
      "Correction: do not deploy without approval",
    ]);
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const result = await cycle.query("Correction");
    expect(result.status).toBe("complete");
    expect(result.excerpts[0]?.text).toBe("Correction: do not deploy without approval");
    expect(fixture.sourceReads).toHaveLength(1);
    expect(fixture.sourceReads[0]?.reference.messageRange).toEqual({ start: 10000, end: 10001 });
    expect(fixture.physicalBytes).toBeLessThan(continuityBudget.maxSourceBytes);
    expect(fixture.legacyArchiveReads).toBe(0);
    await cycle.close();
    expect(fixture.closes).toHaveLength(1);
  });
  it("keeps failure distinct from healthy zero matches and never leaks errors", async () => {
    const fixture = createContinuityFixture();
    fixture.setFault("failure");
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const result = await cycle.query("nothing");
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("forbidden-secret");
    await cycle.close();
  });
  it("continues healthy zero-match recall with an explicit accessible-evidence outcome", async () => {
    const fixture = createContinuityFixture();
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    expect(await cycle.query("absent")).toMatchObject({
      status: "no_accessible_evidence",
      excerpts: [],
      diagnostics: [],
    });
    await cycle.close();
  });
  it("rejects an opened scope mismatch without returning forbidden identifiers", async () => {
    const fixture = createContinuityFixture();
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: { ...continuityScope, repositoryId: "forbidden-secret-repository" },
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const result = await cycle.query("absent");
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("forbidden-secret");
    expect(fixture.sourceReads).toHaveLength(0);
    await cycle.close();
  });
  it("rejects nonconforming capabilities before opening the store", () => {
    const fixture = createContinuityFixture();
    expect(() =>
      validateRecallConfiguration({
        store: { ...fixture.store, capabilities: { ...fixture.store.capabilities, boundedReads: false } },
        budget: continuityBudget,
      }),
    ).toThrow("bounded");
    expect(fixture.opens).toHaveLength(0);
  });
  it("reports partial negation context and never silently cuts an excerpt", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "  Do not deploy.  ");
    fixture.mutateExcerpt("A:0", { completeness: "partial", omissions: ["negation_context"], completeGroup: false });
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const result = await cycle.query("deploy");
    expect(result.status).toBe("partial");
    expect(result.excerpts[0]).toMatchObject({
      text: "  Do not deploy.  ",
      completeness: "partial",
      omissions: ["negation_context"],
    });
    await cycle.close();
  });
  it("rejects a revision change between discovery and physical read", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    fixture.onRead(() => fixture.revoke());
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    expect(await cycle.query("relevant")).toMatchObject({
      status: "failed",
      excerpts: [],
      diagnostics: [{ code: "revision_changed", phase: "read" }],
    });
    await cycle.close();
  });
  it("discards an oversized metadata response and never materializes source content", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    const store = transformStore(fixture.store, (session) => ({
      ...session,
      async discover() {
        return { candidates: [], partial: false, viewRevision: "1", secret: "x".repeat(5000) };
      },
    }));
    const cycle = await openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    expect(await cycle.query("relevant")).toMatchObject({
      status: "failed",
      excerpts: [],
      diagnostics: [{ code: "byte_limit" }],
    });
    expect(fixture.physicalBytes).toBe(0);
    await cycle.close();
  });
  it("rejects forged canonical range metadata and mismatched source locators", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    const store = transformStore(fixture.store, (session) => ({
      ...session,
      async read(request, limits) {
        const result = await session.read(request, limits);
        return result.status === "found"
          ? {
              ...result,
              excerpt: { ...result.excerpt, reference: { ...result.excerpt.reference, sourceRevision: "forged" } },
            }
          : result;
      },
    }));
    const cycle = await openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    expect(await cycle.query("relevant")).toMatchObject({
      status: "failed",
      excerpts: [],
      diagnostics: [{ code: "invalid_response" }],
    });
    await cycle.close();
  });
  it("enforces token bounds without truncating a physically bounded complete source group", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "Do not deploy");
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: { ...continuityBudget, maxEvidenceTokens: 1 },
      signal: new AbortController().signal,
    });
    expect(await cycle.query("deploy")).toMatchObject({
      status: "partial",
      excerpts: [],
      diagnostics: [{ code: "token_limit" }],
    });
    expect(fixture.sourceReads).toHaveLength(1);
    await cycle.close();
  });
  it("shares query/source/token allowances across a clarification cycle", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    const usage = createRecallUsage();
    const options = {
      store: fixture.store,
      scope: continuityScope,
      budget: { ...continuityBudget, maxQueries: 1 },
      signal: new AbortController().signal,
      usage,
    };
    const first = await openRecallCycle(options);
    expect((await first.query("relevant")).status).toBe("complete");
    await first.close();
    const second = await openRecallCycle(options);
    expect(await second.query("relevant")).toMatchObject({ status: "partial", diagnostics: [{ code: "query_limit" }] });
    expect(fixture.discoveries).toHaveLength(1);
    await second.close();
  });
  it("aborts a timed-out source read and reports timeout distinctly", async () => {
    vi.useFakeTimers();
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    let sourceSignal: AbortSignal | undefined;
    const store = transformStore(fixture.store, (session) => ({
      ...session,
      async read(_request, limits) {
        sourceSignal = limits.signal;
        return new Promise(() => {});
      },
    }));
    const cycle = await openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const pending = cycle.query("relevant");
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: "failed", diagnostics: [{ code: "deadline", phase: "read" }] });
    expect(sourceSignal?.aborted).toBe(true);
    await cycle.close();
  });
  it("propagates cancellation rather than returning an empty recall outcome", async () => {
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    const controller = new AbortController();
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let sourceSignal: AbortSignal | undefined;
    const store = transformStore(fixture.store, (session) => ({
      ...session,
      async read(_request, limits) {
        sourceSignal = limits.signal;
        enter?.();
        return new Promise(() => {});
      },
    }));
    const cycle = await openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: controller.signal,
    });
    const pending = cycle.query("relevant");
    const assertion = expect(pending).rejects.toThrow("cancel test");
    await entered;
    controller.abort(new Error("cancel test"));
    await assertion;
    expect(sourceSignal?.aborted).toBe(true);
    await cycle.close();
    expect(fixture.closes).toHaveLength(1);
  });
  it("gives validation a fresh finite metadata window after the source deadline", async () => {
    vi.useFakeTimers();
    const fixture = createContinuityFixture();
    fixture.seedArchive("A", "relevant");
    const cycle = await openRecallCycle({
      store: fixture.store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    const result = await cycle.query("relevant");
    await vi.advanceTimersByTimeAsync(150);
    expect(await cycle.validate(result.excerpts.map((entry) => entry.reference))).toEqual({ valid: true });
    expect(fixture.validations[0]?.limits.deadline).toBe(Date.now() + 50);
    expect(fixture.validations[0]?.limits.remainingTokens).toBe(0);
    await cycle.close();
  });
  it("owns a late opened session even after abandoning the source deadline", async () => {
    vi.useFakeTimers();
    const fixture = createContinuityFixture();
    let resolveOpen: ((session: RecallSession) => void) | undefined;
    const store: RecallStore = {
      ...fixture.store,
      open: () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    };
    const pending = openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(101);
    const cycle = await pending;
    expect(cycle.result().status).toBe("failed");
    const session = await fixture.store.open(continuityScope, {
      signal: new AbortController().signal,
      deadline: Date.now() + 50,
      remainingBytes: 1024,
      remainingTokens: 0,
    });
    resolveOpen?.(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.closes).toHaveLength(1);
    await cycle.close();
  });
  it("closes an acquired session when the result crosses the source deadline before acceptance", async () => {
    vi.useFakeTimers();
    const fixture = createContinuityFixture();
    const store: RecallStore = {
      ...fixture.store,
      async open(scope, limits) {
        const session = await fixture.store.open(scope, limits);
        vi.setSystemTime(limits.deadline + 1);
        return session;
      },
    };
    const cycle = await openRecallCycle({
      store,
      scope: continuityScope,
      budget: continuityBudget,
      signal: new AbortController().signal,
    });
    expect(cycle.result()).toMatchObject({ status: "failed", diagnostics: [{ code: "deadline" }] });
    await cycle.close();
    expect(fixture.closes).toEqual([1]);
  });
  it("closes an acquired session if caller cancellation races its open result", async () => {
    const fixture = createContinuityFixture();
    const controller = new AbortController();
    const store: RecallStore = {
      ...fixture.store,
      async open(scope, limits) {
        const session = await fixture.store.open(scope, limits);
        controller.abort(new Error("open result cancelled"));
        return session;
      },
    };
    await expect(
      openRecallCycle({ store, scope: continuityScope, budget: continuityBudget, signal: controller.signal }),
    ).rejects.toThrow("open result cancelled");
    expect(fixture.closes).toEqual([1]);
  });
});

function transformStore(store: RecallStore, transform: (session: RecallSession) => RecallSession): RecallStore {
  return {
    ...store,
    async open(scope, limits) {
      return transform(await store.open(scope, limits));
    },
  };
}
