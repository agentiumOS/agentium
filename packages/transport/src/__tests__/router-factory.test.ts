import { Registry, registry } from "@agentium/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentRouter } from "../express/router-factory.js";

vi.mock("node:module", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:module")>();
  return {
    ...mod,
    createRequire: () => (id: string) => {
      if (id === "express") {
        return {
          Router: () => ({
            post: vi.fn(),
            get: vi.fn(),
            use: vi.fn(),
          }),
        };
      }
      return mod.createRequire(import.meta.url)(id);
    },
  };
});

beforeEach(() => {
  registry.clear();
});

describe("createAgentRouter", () => {
  it("returns a router object with post and get methods", () => {
    const fakeAgent = {
      providerId: "test",
      run: vi.fn().mockResolvedValue({ text: "hi" }),
      stream: vi.fn(),
    };

    const router = createAgentRouter({
      agents: { assistant: fakeAgent as any },
      registry: false,
    });

    expect(router).toBeDefined();
    expect(router.post).toBeDefined();
  });

  it("creates routes for agents", () => {
    const fakeAgent = {
      providerId: "test",
      run: vi.fn(),
      stream: vi.fn(),
    };

    const router = createAgentRouter({ agents: { bot: fakeAgent as any }, registry: false });
    expect(router.post).toHaveBeenCalled();

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/agents/bot/run");
    expect(postPaths).toContain("/agents/bot/stream");
    expect(postPaths).toContain("/agents/bot/corrections");
  });

  describe("corrections endpoint", () => {
    function makeRes() {
      const res: any = {
        statusCode: 200,
        body: undefined,
        status: vi.fn().mockImplementation((code: number) => {
          res.statusCode = code;
          return res;
        }),
        json: vi.fn().mockImplementation((payload: unknown) => {
          res.body = payload;
          return res;
        }),
      };
      return res;
    }

    function getCorrectionsHandler(router: any): (req: any, res: any) => Promise<void> {
      const call = router.post.mock.calls.find(([path]: any) => path === "/agents/bot/corrections");
      return call[call.length - 1];
    }

    it("returns 404 when corrections are not enabled on the agent", async () => {
      const fakeAgent = { providerId: "test", run: vi.fn(), stream: vi.fn(), memory: null };
      const router = createAgentRouter({ agents: { bot: fakeAgent as any }, registry: false });

      const res = makeRes();
      await getCorrectionsHandler(router)({ body: { originalValue: "a", correctedValue: "b" }, headers: {} }, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.error).toContain("not enabled");
    });

    it("records a correction and returns 201", async () => {
      const recordCorrection = vi.fn().mockResolvedValue({ id: "c1", originalValue: "a", correctedValue: "b" });
      const fakeAgent = {
        providerId: "test",
        run: vi.fn(),
        stream: vi.fn(),
        memory: { getCorrectionStore: () => ({}), recordCorrection },
      };
      const router = createAgentRouter({ agents: { bot: fakeAgent as any }, registry: false });

      const res = makeRes();
      await getCorrectionsHandler(router)(
        {
          body: {
            originalValue: "THC",
            correctedValue: "DTHC",
            field: "chargeCode",
            entityKey: "vendor-x",
            reason: "vendor convention",
          },
          headers: {},
        },
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(res.body.id).toBe("c1");
      expect(recordCorrection).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: "bot",
          originalValue: "THC",
          correctedValue: "DTHC",
          field: "chargeCode",
          entityKey: "vendor-x",
        }),
      );
    });

    it("returns 400 when required fields are missing", async () => {
      const fakeAgent = {
        providerId: "test",
        run: vi.fn(),
        stream: vi.fn(),
        memory: { getCorrectionStore: () => ({}), recordCorrection: vi.fn() },
      };
      const router = createAgentRouter({ agents: { bot: fakeAgent as any }, registry: false });

      const res = makeRes();
      await getCorrectionsHandler(router)({ body: { originalValue: "only-one" }, headers: {} }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain("correctedValue");
    });
  });

  it("creates routes for teams", () => {
    const fakeTeam = { run: vi.fn(), stream: vi.fn() };
    const router = createAgentRouter({ teams: { myteam: fakeTeam as any }, registry: false });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/teams/myteam/run");
    expect(postPaths).toContain("/teams/myteam/stream");
  });

  it("creates routes for workflows", () => {
    const fakeWorkflow = { run: vi.fn() };
    const router = createAgentRouter({ workflows: { flow1: fakeWorkflow as any }, registry: false });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/workflows/flow1/run");
  });

  it("auto-discovers agents, teams, and workflows from serve array", () => {
    const fakeAgent = { kind: "agent", name: "bot", providerId: "test", run: vi.fn(), stream: vi.fn() };
    const fakeTeam = { kind: "team", name: "squad", run: vi.fn(), stream: vi.fn() };
    const fakeWorkflow = { kind: "workflow", name: "pipeline", run: vi.fn() };

    const router = createAgentRouter({
      serve: [fakeAgent as any, fakeTeam as any, fakeWorkflow as any],
      registry: false,
    });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/agents/bot/run");
    expect(postPaths).toContain("/agents/bot/stream");
    expect(postPaths).toContain("/teams/squad/run");
    expect(postPaths).toContain("/teams/squad/stream");
    expect(postPaths).toContain("/workflows/pipeline/run");
  });

  it("merges serve with explicit agents/teams", () => {
    const servedAgent = { kind: "agent", name: "auto", providerId: "test", run: vi.fn(), stream: vi.fn() };
    const explicitAgent = { providerId: "test", run: vi.fn(), stream: vi.fn() };

    const router = createAgentRouter({
      serve: [servedAgent as any],
      agents: { manual: explicitAgent as any },
      registry: false,
    });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/agents/auto/run");
    expect(postPaths).toContain("/agents/manual/run");
  });
});

describe("createAgentRouter — registry", () => {
  it("creates dynamic routes for registry-based lookup", () => {
    const reg = new Registry();
    const router = createAgentRouter({ registry: reg });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/agents/:name/run");
    expect(postPaths).toContain("/agents/:name/stream");
    expect(postPaths).toContain("/teams/:name/run");
    expect(postPaths).toContain("/teams/:name/stream");
    expect(postPaths).toContain("/workflows/:name/run");
  });

  it("creates GET /agents, /teams, /workflows, /registry endpoints", () => {
    const reg = new Registry();
    const router = createAgentRouter({ registry: reg });

    const getPaths = (router.get as any).mock.calls.map(([path]: any) => path);
    expect(getPaths).toContain("/agents");
    expect(getPaths).toContain("/teams");
    expect(getPaths).toContain("/workflows");
    expect(getPaths).toContain("/registry");
  });

  it("uses global registry by default", () => {
    const router = createAgentRouter({});

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).toContain("/agents/:name/run");
  });

  it("does not create dynamic routes when registry is false", () => {
    const router = createAgentRouter({ registry: false });

    const postPaths = (router.post as any).mock.calls.map(([path]: any) => path);
    expect(postPaths).not.toContain("/agents/:name/run");
  });
});
