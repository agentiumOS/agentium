import { InMemoryStorage, registry } from "@agentium/core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAdminGateway } from "../admin-gateway.js";

const mockTool = {
  name: "calculator",
  description: "Evaluate math",
  parameters: z.object({ expression: z.string() }),
  execute: async () => "42",
};

function createMockIO() {
  const handlers: Record<string, Function> = {};
  const nsEmitted: Array<{ event: string; data: any }> = [];

  const mockSocket = {
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
  };

  const mockNamespace = {
    use(_mw: any) {},
    on(event: string, handler: Function) {
      if (event === "connection") {
        handler(mockSocket);
      }
    },
    emit(event: string, data: any) {
      nsEmitted.push({ event, data });
    },
  };

  const mockIO = {
    of(_path: string) {
      return mockNamespace;
    },
  };

  return {
    io: mockIO,
    handlers,
    nsEmitted,
    emit: async (event: string, data: any): Promise<any> => {
      return new Promise((resolve) => {
        const handler = handlers[event];
        if (!handler) throw new Error(`No handler for event: ${event}`);
        handler(data, (res: any) => resolve(res));
      });
    },
  };
}

describe("Admin Gateway", () => {
  let mock: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    registry.clear();
    mock = createMockIO();
    createAdminGateway({
      io: mock.io,
      storage: new InMemoryStorage(),
    });
  });

  // ── Agent CRUD ────────────────────────────────────────────────────

  describe("admin.agent.create", () => {
    it("creates an agent", async () => {
      const res = await mock.emit("admin.agent.create", {
        name: "bot",
        provider: "openai",
        model: "gpt-4o-mini",
      });

      expect(res.ok).toBe(true);
      expect(res.data.name).toBe("bot");
      expect(registry.getAgent("bot")).toBeDefined();
    });

    it("broadcasts created event", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      expect(mock.nsEmitted.some((e) => e.event === "admin.agent.created")).toBe(true);
    });

    it("fails on missing fields", async () => {
      const res = await mock.emit("admin.agent.create", { name: "bot" });
      expect(res.ok).toBe(false);
    });

    it("fails on duplicate", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("already exists");
    });
  });

  describe("admin.agent.list", () => {
    it("lists agents", async () => {
      await mock.emit("admin.agent.create", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      await mock.emit("admin.agent.create", { name: "a2", provider: "openai", model: "gpt-4o" });

      const res = await mock.emit("admin.agent.list", {});
      expect(res.ok).toBe(true);
      expect(res.data).toHaveLength(2);
    });
  });

  describe("admin.agent.get", () => {
    it("gets a single agent", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.agent.get", { name: "bot" });
      expect(res.ok).toBe(true);
      expect(res.data.name).toBe("bot");
    });

    it("returns error for missing agent", async () => {
      const res = await mock.emit("admin.agent.get", { name: "nope" });
      expect(res.ok).toBe(false);
    });
  });

  describe("admin.agent.update", () => {
    it("updates an agent", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.agent.update", { name: "bot", model: "gpt-4o" });
      expect(res.ok).toBe(true);
      expect(res.data.model).toBe("gpt-4o");
    });
  });

  describe("admin.agent.delete", () => {
    it("deletes an agent", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.agent.delete", { name: "bot" });
      expect(res.ok).toBe(true);
      expect(registry.getAgent("bot")).toBeUndefined();
      expect(mock.nsEmitted.some((e) => e.event === "admin.agent.deleted")).toBe(true);
    });
  });

  // ── Team CRUD ─────────────────────────────────────────────────────

  describe("admin.team.create", () => {
    it("creates a team", async () => {
      await mock.emit("admin.agent.create", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.team.create", {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["a1"],
      });

      expect(res.ok).toBe(true);
      expect(registry.getTeam("squad")).toBeDefined();
    });

    it("fails when member doesn't exist", async () => {
      const res = await mock.emit("admin.team.create", {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["ghost"],
      });
      expect(res.ok).toBe(false);
    });
  });

  describe("admin.team.delete", () => {
    it("deletes a team", async () => {
      await mock.emit("admin.agent.create", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      await mock.emit("admin.team.create", {
        name: "squad",
        mode: "route",
        provider: "openai",
        model: "gpt-4o",
        members: ["a1"],
      });

      const res = await mock.emit("admin.team.delete", { name: "squad" });
      expect(res.ok).toBe(true);
      expect(registry.getTeam("squad")).toBeUndefined();
    });
  });

  // ── Workflow CRUD ─────────────────────────────────────────────────

  describe("admin.workflow.create", () => {
    it("creates a workflow placeholder", async () => {
      const res = await mock.emit("admin.workflow.create", { name: "pipe", description: "A pipeline" });
      expect(res.ok).toBe(true);
      expect(res.data.name).toBe("pipe");
    });
  });

  // ── Registry ──────────────────────────────────────────────────────

  describe("admin.registry.list", () => {
    it("lists all registered names", async () => {
      await mock.emit("admin.agent.create", { name: "bot", provider: "openai", model: "gpt-4o-mini" });
      const res = await mock.emit("admin.registry.list", {});
      expect(res.ok).toBe(true);
      expect(res.data.agents).toContain("bot");
    });
  });

  // ── Hydration ─────────────────────────────────────────────────────

  describe("hydrate", () => {
    it("re-creates persisted entities", async () => {
      const storage = new InMemoryStorage();

      const mock1 = createMockIO();
      createAdminGateway({ io: mock1.io, storage });
      await mock1.emit("admin.agent.create", { name: "persistent", provider: "openai", model: "gpt-4o-mini" });

      registry.clear();

      const mock2 = createMockIO();
      const { hydrate: h2 } = createAdminGateway({ io: mock2.io, storage });
      const counts = await h2();

      expect(counts.agents).toBe(1);
      expect(registry.getAgent("persistent")).toBeDefined();
    });
  });

  // ── Tools listing ──────────────────────────────────────────────────

  describe("admin.tools", () => {
    it("lists available tools", async () => {
      const mock = createMockIO();
      createAdminGateway({ io: mock.io, storage: new InMemoryStorage(), toolLibrary: { calculator: mockTool as any } });
      const result = await mock.emit("admin.tools.list", {});

      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("calculator");
    });

    it("gets a tool by name", async () => {
      const mock = createMockIO();
      createAdminGateway({ io: mock.io, storage: new InMemoryStorage(), toolLibrary: { calculator: mockTool as any } });
      const result = await mock.emit("admin.tools.get", { name: "calculator" });

      expect(result.ok).toBe(true);
      expect(result.data.name).toBe("calculator");
    });

    it("returns error for unknown tool", async () => {
      const mock = createMockIO();
      createAdminGateway({ io: mock.io, storage: new InMemoryStorage() });
      const result = await mock.emit("admin.tools.get", { name: "nope" });

      expect(result.ok).toBe(false);
    });
  });
});
