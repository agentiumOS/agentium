import { randomUUID } from "node:crypto";
import {
  classifyServables,
  collectToolkitTools,
  describeToolLibrary,
  registry as globalRegistry,
  schemaShape,
} from "@agentium/core";
import type { HostedIdentity } from "../express/types.js";
import { ownIterator, textStreamLimits } from "../text-stream.js";
import type { GatewayOptions, GatewayResourceRequest } from "./types.js";

export function createAgentGateway(options: GatewayOptions): void {
  const security = options?.security;
  if (!security || !["local", "authenticated"].includes(security.mode))
    throw new Error("Explicit gateway security mode required");
  if (
    security.mode === "authenticated" &&
    (typeof security.resolveIdentity !== "function" || typeof security.authorizeResource !== "function")
  )
    throw new Error("Authenticated gateway requires identity and resource authorization hooks");
  if (security.mode === "local" && options.authMiddleware)
    throw new Error("authMiddleware requires authenticated gateway security");
  const limits = textStreamLimits(options.textStream);
  const maxRuns = options.maxConcurrentRuns ?? 4;
  const maxOutput = options.maxOutputBytes ?? 256 * 1024;
  const maxRequests = options.maxRequestsPerMinute ?? 60;
  for (const value of [maxRuns, maxOutput, maxRequests])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid gateway limit");
  const discovered = options.serve?.length ? classifyServables(options.serve) : undefined;
  const agents = { ...discovered?.agents, ...options.agents };
  const teams = { ...discovered?.teams, ...options.teams };
  const workflows = discovered?.workflows ?? {};
  const reg = options.registry === false ? null : (options.registry ?? globalRegistry);
  const tools = { ...(options.toolkits ? collectToolkitTools(options.toolkits) : {}), ...options.toolLibrary };
  const ns = options.io.of(options.namespace ?? "/agentium");
  if (options.authMiddleware) {
    const authenticate = options.authMiddleware;
    ns.use((socket: any, next: (error?: Error) => void) => {
      let settled = false;
      let requested = false;
      let completed = false;
      let decision: Error | undefined;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        next(error ? new Error("Authentication failed") : undefined);
      };
      const requestNext = (error?: Error) => {
        if (requested || completed) return;
        requested = true;
        decision = error;
        if (settled) finish(decision);
      };
      try {
        // Defer admission until the callback returns and any returned promise settles.
        // A callback calling next() and then throwing/rejecting must still deny access.
        const work = authenticate(socket, requestNext);
        void Promise.resolve(work)
          .then(() => {
            settled = true;
            if (requested) finish(decision);
          })
          .catch(() => finish(new Error("Authentication failed")));
      } catch {
        finish(new Error("Authentication failed"));
      }
    });
  }

  ns.on("connection", (socket: any) => {
    let connected = true;
    let count = 0;
    let resetAt = Date.now() + 60_000;
    const active = new Map<string, { controller: AbortController; identity?: HostedIdentity; sessionId?: string }>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const connection = new AbortController();
    const valid = () => {
      if (!connected || socket.connected === false) throw new Error("Socket disconnected");
    };
    const bounded = (payload: unknown) => {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > limits.maxFrameBytes) throw new Error("Socket frame byte limit exceeded");
      return bytes;
    };
    let pendingBytes = 0;
    let writes: Promise<void> = Promise.resolve();
    const waitWritable = async () => {
      const conn = socket.conn;
      if (!conn || (!conn.writeBuffer?.length && conn.transport?.writable !== false)) return;
      await new Promise<void>((resolve, reject) => {
        let transport = conn.transport;
        const cleanup = () => {
          clearTimeout(timer);
          conn.off("drain", check);
          conn.off("upgrade", upgrade);
          transport?.off("ready", check);
          transport?.off("drain", check);
          connection.signal.removeEventListener("abort", abort);
        };
        const check = () =>
          queueMicrotask(() => {
            if (!conn.writeBuffer?.length && conn.transport?.writable !== false) {
              cleanup();
              resolve();
            }
          });
        const upgrade = () => {
          transport?.off("ready", check);
          transport?.off("drain", check);
          transport = conn.transport;
          transport?.on("ready", check);
          transport?.on("drain", check);
          check();
        };
        const abort = () => {
          cleanup();
          reject(connection.signal.reason);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Socket write deadline exceeded"));
        }, limits.writeTimeoutMs);
        conn.on("drain", check);
        conn.on("upgrade", upgrade);
        transport?.on("ready", check);
        transport?.on("drain", check);
        connection.signal.addEventListener("abort", abort, { once: true });
        if (connection.signal.aborted) abort();
        else check();
      });
    };
    const send = async (event: string, payload: unknown, ack?: Function) => {
      valid();
      // Count protocol framing conservatively as well as the application payload.
      const bytes = bounded([event, payload]) + 64;
      if (pendingBytes + bytes > limits.maxBufferedBytes) throw new Error("Socket buffer byte limit exceeded");
      pendingBytes += bytes;
      const next = writes
        .then(async () => {
          valid();
          await waitWritable();
          valid();
          if (ack) ack(payload);
          else socket.emit(event, payload);
          await waitWritable();
        })
        .finally(() => {
          pendingBytes -= bytes;
        });
      writes = next.catch(() => {});
      return next;
    };
    const identity = async (): Promise<HostedIdentity | undefined> => {
      valid();
      if (Date.now() > resetAt) {
        count = 0;
        resetAt = Date.now() + 60_000;
      }
      if (++count > maxRequests) throw new Error("Rate limit exceeded");
      if (security.mode === "local") return undefined;
      const resolved = await security.resolveIdentity(socket.data);
      valid();
      if (
        !resolved ||
        typeof resolved.userId !== "string" ||
        !resolved.userId.trim() ||
        (resolved.tenantId !== undefined && (typeof resolved.tenantId !== "string" || !resolved.tenantId.trim()))
      )
        throw new Error("Authentication required");
      return Object.freeze({ userId: resolved.userId, tenantId: resolved.tenantId });
    };
    const authorize = async (
      actor: HostedIdentity | undefined,
      operation: GatewayResourceRequest["operation"],
      resource: GatewayResourceRequest["resource"],
    ) => {
      if (
        security.mode === "authenticated" &&
        (await security.authorizeResource({ identity: actor!, operation, resource })) !== true
      )
        throw new Error("Resource access denied");
      valid();
    };
    const on = (event: string, fn: (...args: any[]) => Promise<void>) => {
      const handler = (...args: any[]) =>
        fn(...args).catch(async () => {
          const ack = args[1];
          if (!connected) return;
          if (typeof ack === "function") {
            try {
              await send(event, { error: "Request denied" }, ack);
            } catch {}
          } else {
            try {
              await send("agent.error", { error: "Request denied" });
            } catch {}
          }
        });
      handlers.set(event, handler);
      socket.on(event, handler);
    };

    for (const kind of ["agent", "team", "workflow"] as const) {
      on(`${kind}.run`, async (data: any) => {
        const runId = randomUUID();
        if (active.size >= maxRuns) {
          await send("agent.error", { runId, error: "Concurrent run limit exceeded" });
          return;
        }
        const state = {
          controller: new AbortController(),
          identity: undefined as HostedIdentity | undefined,
          sessionId: undefined as string | undefined,
        };
        active.set(runId, state);
        let iterator: AsyncIterator<any> | undefined;
        let ownedIterator: ReturnType<typeof ownIterator> | undefined;
        let output: unknown;
        let failure: unknown;
        try {
          const actor = await identity();
          state.identity = actor;
          if (
            !data ||
            typeof data.name !== "string" ||
            !data.name.trim() ||
            (kind !== "workflow" && (typeof data.input !== "string" || !data.input.trim()))
          )
            throw new Error("Invalid input");
          bounded(data);
          if (data.sessionId !== undefined && (typeof data.sessionId !== "string" || !data.sessionId.trim()))
            throw new Error("Invalid sessionId");
          if (
            security.mode === "authenticated" &&
            ["userId", "tenantId", "apiKey", "room", "runId"].some((key) => data[key] !== undefined)
          )
            throw new Error("Client identity or credentials are not accepted");
          await authorize(actor, "execute", { kind, id: data.name });
          const target =
            kind === "agent"
              ? (agents[data.name] ?? reg?.getAgent(data.name))
              : kind === "team"
                ? (teams[data.name] ?? reg?.getTeam(data.name))
                : (workflows[data.name] ?? reg?.getWorkflow(data.name));
          if (!target) throw new Error(`${kind} "${data.name}" not found`);
          const sessionId = data.sessionId ?? randomUUID();
          await authorize(actor, data.sessionId ? "session:use" : "session:create", {
            kind: "session",
            id: sessionId,
            target: data.name,
          });
          state.sessionId = sessionId;
          state.controller.signal.throwIfAborted();
          await send("agent.started", { runId, sessionId });
          state.controller.signal.throwIfAborted();
          const runOpts = {
            ...actor,
            sessionId,
            runId,
            signal: state.controller.signal,
            ...(security.mode === "local" ? { apiKey: data.apiKey ?? socket.handshake?.auth?.apiKey } : {}),
          };
          if (kind === "agent") {
            iterator = (target as any).stream(data.input, runOpts)[Symbol.asyncIterator]();
            ownedIterator = ownIterator(iterator!, state.controller.signal);
            let fullText = "";
            let usage: unknown;
            let size = 0;
            while (true) {
              state.controller.signal.throwIfAborted();
              const next = await iterator!.next();
              state.controller.signal.throwIfAborted();
              if (next.done) break;
              const chunk = next.value;
              if (chunk.type === "text") {
                size += Buffer.byteLength(chunk.text);
                if (size > maxOutput) throw new Error("Output byte limit exceeded");
                fullText += chunk.text;
                await send("agent.chunk", { runId, sessionId, chunk: chunk.text });
              } else if (chunk.type === "tool_call_start")
                await send("agent.tool.call", { runId, sessionId, toolName: chunk.toolCall.name, args: null });
              else if (chunk.type === "tool_call_end")
                await send("agent.tool.done", { runId, sessionId, toolCallId: chunk.toolCallId });
              else if (chunk.type === "finish") usage = chunk.usage;
            }
            output = { text: fullText, usage };
          } else
            output =
              kind === "workflow" ? await (target as any).run(runOpts) : await (target as any).run(data.input, runOpts);
          state.controller.signal.throwIfAborted();
          bounded({ runId, sessionId, output });
        } catch (error) {
          failure = error;
          state.controller.abort(error);
        } finally {
          try {
            await ownedIterator?.close();
          } catch (error) {
            failure ??= error;
          }
          ownedIterator?.dispose();
          active.delete(runId);
        }
        if (connected) {
          try {
            await send(failure ? "agent.error" : "agent.done", {
              runId,
              sessionId: state.sessionId,
              ...(failure
                ? {
                    error:
                      security.mode === "local" && failure instanceof Error ? failure.message : "Run failed or denied",
                  }
                : { output }),
            });
          } catch {
            socket.disconnect?.(true);
          }
        }
      });
    }
    on("run.cancel", async (data: any, ack?: Function) => {
      const actor = await identity();
      const state = active.get(data?.runId);
      if (!state || actor?.userId !== state.identity?.userId || actor?.tenantId !== state.identity?.tenantId)
        throw new Error("Run not owned");
      await authorize(actor, "run:cancel", { kind: "run", id: data.runId });
      state.controller.abort(new Error("Run canceled"));
      if (typeof ack === "function")
        await send("run.cancel", { runId: data.runId, status: "cancellation_requested" }, ack);
    });
    const list = async (kind: "agent" | "team" | "workflow" | "tool", actor: HostedIdentity | undefined) => {
      const candidates =
        kind === "agent"
          ? {
              ...Object.fromEntries((reg?.describeAgents() ?? []).map((v) => [v.name, v])),
              ...Object.fromEntries(Object.keys(agents).map((name) => [name, { name }])),
            }
          : kind === "team"
            ? {
                ...Object.fromEntries((reg?.describeTeams() ?? []).map((v) => [v.name, v])),
                ...Object.fromEntries(Object.keys(teams).map((name) => [name, { name }])),
              }
            : kind === "workflow"
              ? {
                  ...Object.fromEntries((reg?.describeWorkflows() ?? []).map((v) => [v.name, v])),
                  ...Object.fromEntries(Object.keys(workflows).map((name) => [name, { name }])),
                }
              : Object.fromEntries(describeToolLibrary(tools).map((v) => [v.name, v]));
      const result: unknown[] = [];
      for (const [id, entry] of Object.entries(candidates)) {
        try {
          await authorize(actor, "discover", { kind, id });
          result.push(entry);
        } catch {
          /* Omit denied entries. */
        }
      }
      return result;
    };
    for (const kind of ["agent", "team", "workflow", "tool"] as const)
      on(`${kind}s.list`, async (_data, ack) => {
        const actor = await identity();
        const result = await list(kind, actor);
        valid();
        if (typeof ack === "function") await send("discovery", result, ack);
      });
    on("registry.list", async (_data, ack) => {
      const actor = await identity();
      const result = {
        agents: ((await list("agent", actor)) as any[]).map((v) => v.name),
        teams: ((await list("team", actor)) as any[]).map((v) => v.name),
        workflows: ((await list("workflow", actor)) as any[]).map((v) => v.name),
      };
      valid();
      if (typeof ack === "function") await send("discovery", result, ack);
    });
    on("tools.get", async (data, ack) => {
      const actor = await identity();
      if (typeof data?.name !== "string") throw new Error("Invalid tool");
      await authorize(actor, "discover", { kind: "tool", id: data.name });
      const tool = tools[data.name];
      const result = tool
        ? { name: tool.name, description: tool.description, parameters: Object.keys(schemaShape(tool.parameters)) }
        : { error: "Tool not found" };
      if (typeof ack === "function") await send("tools.get", result, ack);
    });
    socket.once?.("disconnect", () => {
      connected = false;
      connection.abort(new Error("Socket disconnected"));
      for (const state of active.values()) state.controller.abort(new Error("Socket disconnected"));
      for (const [event, handler] of handlers) socket.off(event, handler);
      handlers.clear();
    });
  });
}
