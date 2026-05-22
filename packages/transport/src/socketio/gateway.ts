import type { Registry } from "@agentium/core";
import { classifyServables, collectToolkitTools, describeToolLibrary, registry as globalRegistry } from "@agentium/core";
import type { GatewayOptions } from "./types.js";

function createSocketRateLimiter(maxPerMinute = 60) {
  return () => {
    let count = 0;
    let resetTime = Date.now() + 60000;

    return (): boolean => {
      const now = Date.now();
      if (now > resetTime) {
        count = 0;
        resetTime = now + 60000;
      }
      count++;
      return count <= maxPerMinute;
    };
  };
}

export function createAgentGateway(opts: GatewayOptions): void {
  if (opts.serve?.length) {
    const discovered = classifyServables(opts.serve);
    opts = {
      ...opts,
      agents: { ...discovered.agents, ...opts.agents },
      teams: { ...discovered.teams, ...opts.teams },
    };
  }

  const reg: Registry | null = opts.registry === false ? null : (opts.registry ?? globalRegistry);

  const ns = opts.io.of(opts.namespace ?? "/agentium");

  if (opts.authMiddleware) {
    ns.use(opts.authMiddleware);
  }

  const rateLimiterFactory = createSocketRateLimiter(opts.maxRequestsPerMinute ?? 60);

  ns.on("connection", (socket: any) => {
    const checkRate = rateLimiterFactory();

    socket.on("agent.run", async (data: { name: string; input: string; sessionId?: string; apiKey?: string }) => {
      if (!checkRate()) {
        socket.emit("agent.error", { error: "Rate limit exceeded" });
        return;
      }
      if (!data || typeof data.input !== "string" || !data.input.trim()) {
        socket.emit("agent.error", { error: "Invalid input: must be a non-empty string" });
        return;
      }
      if (data.sessionId !== undefined && typeof data.sessionId !== "string") {
        socket.emit("agent.error", { error: "Invalid sessionId: must be a string" });
        return;
      }

      const agent = opts.agents?.[data.name] ?? reg?.getAgent(data.name);
      if (!agent) {
        socket.emit("agent.error", {
          error: `Agent "${data.name}" not found`,
        });
        return;
      }

      try {
        const apiKey = data.apiKey ?? socket.handshake?.auth?.apiKey;
        const sessionId = data.sessionId ?? socket.id;

        let fullText = "";
        let usage: unknown;
        for await (const chunk of agent.stream(data.input, {
          sessionId,
          apiKey,
        })) {
          if (chunk.type === "text") {
            fullText += chunk.text;
            socket.emit("agent.chunk", { chunk: chunk.text });
          } else if (chunk.type === "tool_call_start") {
            socket.emit("agent.tool.call", {
              toolName: chunk.toolCall.name,
              args: null,
            });
          } else if (chunk.type === "tool_call_end") {
            socket.emit("agent.tool.done", { toolCallId: chunk.toolCallId });
          } else if (chunk.type === "finish" && chunk.usage) {
            usage = chunk.usage;
          }
        }

        socket.emit("agent.done", { output: { text: fullText, usage } });
      } catch (error: any) {
        socket.emit("agent.error", { error: error.message });
      }
    });

    socket.on("agents.list", (_data: unknown, ack?: Function) => {
      if (reg) {
        ack?.(reg.describeAgents());
      } else {
        const names = Object.keys(opts.agents ?? {});
        ack?.(names.map((n) => ({ name: n })));
      }
    });

    socket.on("teams.list", (_data: unknown, ack?: Function) => {
      if (reg) {
        ack?.(reg.describeTeams());
      } else {
        const names = Object.keys(opts.teams ?? {});
        ack?.(names.map((n) => ({ name: n })));
      }
    });

    socket.on("workflows.list", (_data: unknown, ack?: Function) => {
      if (reg) {
        ack?.(reg.describeWorkflows());
      } else {
        ack?.([]);
      }
    });

    socket.on("registry.list", (_data: unknown, ack?: Function) => {
      if (reg) {
        ack?.(reg.list());
      } else {
        ack?.({
          agents: Object.keys(opts.agents ?? {}),
          teams: Object.keys(opts.teams ?? {}),
          workflows: [],
        });
      }
    });

    // ── Tools listing ────────────────────────────────────────────
    const fromToolkits = opts.toolkits ? collectToolkitTools(opts.toolkits) : {};
    const mergedTools = { ...fromToolkits, ...(opts.toolLibrary ?? {}) };

    socket.on("tools.list", (_data: unknown, ack?: Function) => {
      ack?.(describeToolLibrary(mergedTools));
    });

    socket.on("tools.get", (data: { name: string }, ack?: Function) => {
      const tool = mergedTools[data?.name];
      if (!tool) return ack?.({ error: `Tool "${data?.name}" not found` });
      ack?.({
        name: tool.name,
        description: tool.description,
        parameters: Object.keys(tool.parameters.shape ?? {}),
      });
    });

    socket.on("disconnect", () => {
      // Clean up any tracked state for this socket
    });

    socket.on("team.run", async (data: { name: string; input: string; sessionId?: string; apiKey?: string }) => {
      if (!checkRate()) {
        socket.emit("agent.error", { error: "Rate limit exceeded" });
        return;
      }
      if (!data || typeof data.input !== "string" || !data.input.trim()) {
        socket.emit("agent.error", { error: "Invalid input: must be a non-empty string" });
        return;
      }
      if (data.sessionId !== undefined && typeof data.sessionId !== "string") {
        socket.emit("agent.error", { error: "Invalid sessionId: must be a string" });
        return;
      }

      const team = opts.teams?.[data.name] ?? reg?.getTeam(data.name);
      if (!team) {
        socket.emit("agent.error", {
          error: `Team "${data.name}" not found`,
        });
        return;
      }

      try {
        const apiKey = data.apiKey ?? socket.handshake?.auth?.apiKey;
        const result = await team.run(data.input, {
          sessionId: data.sessionId ?? socket.id,
          apiKey,
        });
        socket.emit("agent.done", { output: result });
      } catch (error: any) {
        socket.emit("agent.error", { error: error.message });
      }
    });
  });
}
