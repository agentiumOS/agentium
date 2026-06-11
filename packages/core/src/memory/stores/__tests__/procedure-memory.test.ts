import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { ProcedureMemory } from "../procedure-memory.js";

describe("ProcedureMemory — scope hierarchy", () => {
  let storage: InMemoryStorage;
  let pm: ProcedureMemory;

  beforeEach(() => {
    storage = new InMemoryStorage();
    pm = new ProcedureMemory(storage);
  });

  const baseProc = {
    trigger: "invoice reconciliation",
    description: "Look up PO, diff lines, escalate to AP",
    steps: [
      { toolName: "lookup_po", argsSnapshot: {}, resultSummary: "PO #123 found" },
      { toolName: "diff_lines", argsSnapshot: {}, resultSummary: "2 lines drift" },
    ],
  };

  it("defaults to user scope when not specified", async () => {
    const p = await pm.saveProcedure({ ...baseProc, userId: "alice" });
    expect(p.scope).toBe("user");
  });

  it("user procedure is invisible to a different user", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "user", userId: "alice" });
    const bobSuggestion = await pm.suggestProcedure({ userId: "bob" }, "invoice reconciliation");
    expect(bobSuggestion).toBeNull();
  });

  it("user procedure is visible to the saving user", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "user", userId: "alice" });
    const s = await pm.suggestProcedure({ userId: "alice" }, "invoice reconciliation");
    expect(s).not.toBeNull();
    expect(s?.scope).toBe("user");
  });

  it("agent procedure is visible to ANY user of that agent", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "agent", agentName: "invoice-recon" });
    const alice = await pm.suggestProcedure({ userId: "alice", agentName: "invoice-recon" }, "invoice reconciliation");
    const bob = await pm.suggestProcedure({ userId: "bob", agentName: "invoice-recon" }, "invoice reconciliation");
    expect(alice?.scope).toBe("agent");
    expect(bob?.scope).toBe("agent");
  });

  it("agent procedure is INVISIBLE to a different agent", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "agent", agentName: "invoice-recon" });
    const hr = await pm.suggestProcedure({ userId: "alice", agentName: "hr-agent" }, "invoice reconciliation");
    expect(hr).toBeNull();
  });

  it("tenant procedure is visible across users + agents within the tenant", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "tenant", tenantId: "acme-corp" });
    const ok = await pm.suggestProcedure(
      { userId: "alice", agentName: "agent-a", tenantId: "acme-corp" },
      "invoice reconciliation",
    );
    const other = await pm.suggestProcedure(
      { userId: "bob", agentName: "agent-b", tenantId: "meridian" },
      "invoice reconciliation",
    );
    expect(ok?.scope).toBe("tenant");
    expect(other).toBeNull();
  });

  it("getProcedures unions all accessible scopes", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "user", userId: "alice", trigger: "personal task" });
    await pm.saveProcedure({ ...baseProc, scope: "agent", agentName: "team", trigger: "team task" });
    await pm.saveProcedure({ ...baseProc, scope: "tenant", tenantId: "org", trigger: "org task" });

    const view = await pm.getProcedures({ userId: "alice", agentName: "team", tenantId: "org" });
    const triggers = view.map((p) => p.trigger);
    expect(triggers).toContain("personal task");
    expect(triggers).toContain("team task");
    expect(triggers).toContain("org task");
  });

  it("getContextString returns empty when no scope identifiers are provided", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "user", userId: "alice" });
    const ctx = await pm.getContextString("invoice", {});
    expect(ctx).toBe("");
  });

  it("getContextString tags non-user scopes", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "agent", agentName: "invoice-recon" });
    const ctx = await pm.getContextString("invoice", { agentName: "invoice-recon" });
    expect(ctx).toContain("[agent]");
  });

  it("saving with scope='agent' but no agentName throws", async () => {
    await expect(pm.saveProcedure({ ...baseProc, scope: "agent" })).rejects.toThrow(/agentName|owner/i);
  });

  it("global procedure is visible to everyone", async () => {
    await pm.saveProcedure({ ...baseProc, scope: "global" });
    const view = await pm.suggestProcedure({ userId: "anyone" }, "invoice reconciliation");
    expect(view?.scope).toBe("global");
  });
});
