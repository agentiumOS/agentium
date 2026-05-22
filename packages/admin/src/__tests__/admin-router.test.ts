import { InMemoryStorage, registry } from "@agentium/core";
import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAdminRouter } from "../admin-router.js";

const mockTool = {
  name: "calculator",
  description: "Evaluate math",
  parameters: z.object({ expression: z.string() }),
  execute: async () => "42",
};

function createTestApp() {
  const storage = new InMemoryStorage();
  const { router, hydrate } = createAdminRouter({
    storage,
    toolLibrary: { calculator: mockTool as any },
  });

  const app = express();
  app.use(express.json());
  app.use("/admin", router);

  return { app, hydrate, storage };
}

async function request(app: any, method: string, path: string, body?: any) {
  const { default: supertest } = await import("supertest" as string).catch(() => ({ default: null }));

  if (!supertest) {
    // Fallback: use raw http for testing without supertest
    return mockRequest(app, method, path, body);
  }

  const req = supertest(app);
  const fn = (req as any)[method.toLowerCase()];
  if (!fn) throw new Error(`Unknown method: ${method}`);

  let chain = fn.call(req, path);
  if (body) chain = chain.send(body).set("Content-Type", "application/json");
  return chain;
}

/**
 * Lightweight request helper using Node's built-in http.
 * Used when supertest is not available.
 */
async function mockRequest(app: any, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const http = await import("node:http");
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: method.toUpperCase(),
          headers: {
            "Content-Type": "application/json",
            ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close(() => {
              try {
                resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null });
              } catch {
                resolve({ status: res.statusCode!, body: data });
              }
            });
          });
        },
      );

      req.on("error", (err) => {
        server.close(() => reject(err));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });

    server.on("error", (err) => reject(err));
  });
}

describe("Admin Router", () => {
  beforeEach(() => {
    registry.clear();
  });

  // ── Agent CRUD ────────────────────────────────────────────────────

  describe("POST /admin/agents", () => {
    it("creates an agent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/agents", {
        name: "bot",
        provider: "openai",
        model: "gpt-4o-mini",
        instructions: "Be helpful",
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("bot");
      expect(registry.getAgent("bot")).toBeDefined();
    });

    it("returns 400 on missing fields", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/agents", { name: "bot" });
      expect(res.status).toBe(400);
    });

    it("returns 409 on duplicate name", async () => {
      const { app } = createTestApp();
      const body = { name: "bot", provider: "openai", model: "gpt-4o-mini" };
      await request(app, "POST", "/admin/agents", body);
      const res = await request(app, "POST", "/admin/agents", body);
      expect(res.status).toBe(409);
    });

    it("creates agent with tools", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/agents", {
        name: "calc-bot",
        provider: "openai",
        model: "gpt-4o-mini",
        tools: ["calculator"],
      });
      expect(res.status).toBe(201);
      expect(res.body.tools).toEqual(["calculator"]);
    });

    it("returns 422 on invalid tool", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/agents", {
        name: "bot",
        provider: "openai",
        model: "gpt-4o-mini",
        tools: ["fake-tool"],
      });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /admin/agents", () => {
    it("lists agents", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      await request(app, "POST", "/admin/agents", { name: "a2", provider: "openai", model: "gpt-4o" });

      const res = await request(app, "GET", "/admin/agents");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe("GET /admin/agents/:name", () => {
    it("returns a single agent", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "bot", provider: "openai", model: "gpt-4o-mini" });

      const res = await request(app, "GET", "/admin/agents/bot");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("bot");
    });

    it("returns 404 for missing agent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "GET", "/admin/agents/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /admin/agents/:name", () => {
    it("updates an agent", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "bot", provider: "openai", model: "gpt-4o-mini" });

      const res = await request(app, "PUT", "/admin/agents/bot", { model: "gpt-4o" });
      expect(res.status).toBe(200);
      expect(res.body.model).toBe("gpt-4o");
      expect(registry.getAgent("bot")).toBeDefined();
    });

    it("returns 404 for missing agent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "PUT", "/admin/agents/nope", { model: "gpt-4o" });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /admin/agents/:name", () => {
    it("deletes an agent", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "bot", provider: "openai", model: "gpt-4o-mini" });

      const res = await request(app, "DELETE", "/admin/agents/bot");
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe("bot");
      expect(registry.getAgent("bot")).toBeUndefined();
    });

    it("returns 404 for missing agent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "DELETE", "/admin/agents/nope");
      expect(res.status).toBe(404);
    });
  });

  // ── Team CRUD ─────────────────────────────────────────────────────

  describe("POST /admin/teams", () => {
    it("creates a team from existing agents", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      await request(app, "POST", "/admin/agents", { name: "a2", provider: "openai", model: "gpt-4o-mini" });

      const res = await request(app, "POST", "/admin/teams", {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["a1", "a2"],
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("squad");
      expect(registry.getTeam("squad")).toBeDefined();
    });

    it("returns 400 on missing fields", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/teams", { name: "squad" });
      expect(res.status).toBe(400);
    });

    it("returns 422 when member agents don't exist", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/teams", {
        name: "squad",
        mode: "coordinate",
        provider: "openai",
        model: "gpt-4o",
        members: ["ghost"],
      });
      expect(res.status).toBe(422);
    });
  });

  describe("DELETE /admin/teams/:name", () => {
    it("deletes a team", async () => {
      const { app } = createTestApp();
      await request(app, "POST", "/admin/agents", { name: "a1", provider: "openai", model: "gpt-4o-mini" });
      await request(app, "POST", "/admin/teams", {
        name: "squad",
        mode: "route",
        provider: "openai",
        model: "gpt-4o",
        members: ["a1"],
      });

      const res = await request(app, "DELETE", "/admin/teams/squad");
      expect(res.status).toBe(200);
      expect(registry.getTeam("squad")).toBeUndefined();
    });
  });

  // ── Workflow CRUD ─────────────────────────────────────────────────

  describe("POST /admin/workflows", () => {
    it("creates a workflow placeholder", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/workflows", {
        name: "pipe",
        description: "A pipeline",
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("pipe");
    });

    it("returns 400 on missing name", async () => {
      const { app } = createTestApp();
      const res = await request(app, "POST", "/admin/workflows", {});
      expect(res.status).toBe(400);
    });
  });

  // ── Hydration ─────────────────────────────────────────────────────

  describe("hydrate", () => {
    it("re-creates persisted agents on startup", async () => {
      const storage = new InMemoryStorage();

      // First: create via admin
      const { app: app1 } = (() => {
        const result = createAdminRouter({ storage, toolLibrary: { calculator: mockTool as any } });
        const a = express();
        a.use(express.json());
        a.use("/admin", result.router);
        return { app: a };
      })();

      await request(app1, "POST", "/admin/agents", { name: "persistent", provider: "openai", model: "gpt-4o-mini" });
      expect(registry.getAgent("persistent")).toBeDefined();

      // Simulate restart: clear registry
      registry.clear();
      expect(registry.getAgent("persistent")).toBeUndefined();

      // Second: hydrate from same storage
      const { hydrate: h2 } = createAdminRouter({ storage, toolLibrary: { calculator: mockTool as any } });
      const counts = await h2();

      expect(counts.agents).toBe(1);
      expect(registry.getAgent("persistent")).toBeDefined();
    });
  });

  // ── Tools listing ──────────────────────────────────────────────────

  describe("GET /admin/tools", () => {
    it("lists available tools", async () => {
      const { app } = createTestApp();
      const res = await request(app, "GET", "/admin/tools");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("calculator");
      expect(res.body[0].description).toBe("Evaluate math");
      expect(res.body[0].parameters).toContain("expression");
    });

    it("gets a single tool by name", async () => {
      const { app } = createTestApp();
      const res = await request(app, "GET", "/admin/tools/calculator");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("calculator");
    });

    it("returns 404 for unknown tool", async () => {
      const { app } = createTestApp();
      const res = await request(app, "GET", "/admin/tools/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  // ── Toolkits option ────────────────────────────────────────────────

  describe("toolkits option", () => {
    it("merges toolkit tools into toolLibrary", async () => {
      const storage = new InMemoryStorage();
      const mockToolkit = {
        name: "test-toolkit",
        getTools: () => [
          {
            name: "tk_tool",
            description: "From toolkit",
            parameters: z.object({ x: z.string() }),
            execute: async () => "ok",
          },
        ],
      };

      const { router } = createAdminRouter({
        storage,
        toolkits: [mockToolkit as any],
      });

      const app = express();
      app.use(express.json());
      app.use("/admin", router);

      const res = await request(app, "GET", "/admin/tools");
      expect(res.status).toBe(200);
      expect(res.body.find((t: any) => t.name === "tk_tool")).toBeDefined();
    });

    it("explicit toolLibrary overrides toolkit tools", async () => {
      const storage = new InMemoryStorage();
      const overrideTool = {
        name: "calculator",
        description: "Overridden calculator",
        parameters: z.object({ expr: z.string() }),
        execute: async () => "99",
      };

      const mockToolkit = {
        name: "test-toolkit",
        getTools: () => [mockTool],
      };

      const { router } = createAdminRouter({
        storage,
        toolkits: [mockToolkit as any],
        toolLibrary: { calculator: overrideTool as any },
      });

      const app = express();
      app.use(express.json());
      app.use("/admin", router);

      const res = await request(app, "GET", "/admin/tools");
      expect(res.status).toBe(200);
      const calc = res.body.find((t: any) => t.name === "calculator");
      expect(calc.description).toBe("Overridden calculator");
    });
  });
});
