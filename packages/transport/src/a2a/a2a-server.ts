import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2AMessage,
  A2APart,
  A2ATask,
  A2ATaskState,
  Agent,
} from "@agentium/core";
import { generateMultiAgentCard } from "./agent-card.js";
import type { A2AServerOptions } from "./types.js";

const _require = createRequire(import.meta.url);

/**
 * In-memory task store. Can be replaced with a persistent implementation.
 */
class TaskStore {
  private tasks = new Map<string, A2ATask>();
  private maxTasks = 10000;

  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  set(task: A2ATask): void {
    if (this.tasks.size >= this.maxTasks) {
      for (const [id, t] of this.tasks) {
        if (t.status?.state === "completed" || t.status?.state === "canceled") {
          this.tasks.delete(id);
          break;
        }
      }
    }
    this.tasks.set(task.id, task);
  }

  updateState(id: string, state: A2ATaskState, message?: A2AMessage): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = {
      state,
      message,
      timestamp: new Date().toISOString(),
    };
  }
}

function a2aPartsToText(parts: A2APart[]): string {
  return parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

function textToA2AParts(text: string): A2APart[] {
  return [{ kind: "text", text }];
}

function jsonRpcError(id: string | number, code: number, message: string): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resolveAgent(agents: Record<string, Agent>, message: A2AMessage): Agent | null {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const agentName = meta?.agentName as string | undefined;

  if (agentName && agents[agentName]) {
    return agents[agentName];
  }

  const names = Object.keys(agents);
  if (names.length === 1) {
    return agents[names[0]];
  }

  const textContent = a2aPartsToText(message.parts).toLowerCase();
  for (const [name, agent] of Object.entries(agents)) {
    if (textContent.includes(name.toLowerCase())) {
      return agent;
    }
  }

  return agents[names[0]] ?? null;
}

/**
 * Mount an A2A-compliant server on an Express app.
 *
 * - Serves `/.well-known/agent.json` with the Agent Card
 * - Handles JSON-RPC 2.0 requests at the basePath for message/send, message/stream, tasks/get, tasks/cancel
 */
export function createA2AServer(app: any, opts: A2AServerOptions): void {
  const express = _require("express");
  const basePath = opts.basePath ?? "/";
  const taskStore = new TaskStore();

  const serverUrl = basePath === "/" ? "" : basePath;

  const agentCard = generateMultiAgentCard(opts.agents, serverUrl || "/", opts.provider, opts.version);

  app.get("/.well-known/agent.json", (_req: any, res: any) => {
    res.json(agentCard);
  });

  app.use(basePath, express.json({ limit: "1mb" }));

  app.post(basePath, async (req: any, res: any) => {
    const body: A2AJsonRpcRequest = req.body;

    if (!body || body.jsonrpc !== "2.0" || !body.method) {
      return res.status(400).json(jsonRpcError(body?.id ?? 0, -32600, "Invalid JSON-RPC request"));
    }

    try {
      switch (body.method) {
        case "message/send":
          return await handleMessageSend(req, res, body, opts.agents, taskStore);
        case "message/stream":
          return await handleMessageStream(req, res, body, opts.agents, taskStore);
        case "tasks/get":
          return handleTasksGet(res, body, taskStore);
        case "tasks/cancel":
          return handleTasksCancel(res, body, taskStore);
        default:
          return res.json(jsonRpcError(body.id, -32601, `Method '${body.method}' not found`));
      }
    } catch (err: any) {
      return res.json(jsonRpcError(body.id, -32000, err.message ?? "Internal error"));
    }
  });
}

async function handleMessageSend(
  _req: any,
  res: any,
  body: A2AJsonRpcRequest,
  agents: Record<string, Agent>,
  store: TaskStore,
): Promise<void> {
  const params = body.params as any;
  const message: A2AMessage = params?.message;

  if (!message?.parts?.length) {
    return res.json(jsonRpcError(body.id, -32602, "Missing message.parts"));
  }

  const agent = resolveAgent(agents, message);
  if (!agent) {
    return res.json(jsonRpcError(body.id, -32602, "No matching agent found"));
  }

  const taskId = randomUUID();
  const input = a2aPartsToText(message.parts);

  const task: A2ATask = {
    id: taskId,
    sessionId: (params?.sessionId as string) ?? undefined,
    status: { state: "submitted", timestamp: new Date().toISOString() },
    history: [message],
    metadata: { agentName: agent.name },
  };
  store.set(task);
  store.updateState(taskId, "working");

  try {
    const result = await agent.run(input, {
      sessionId: task.sessionId,
    });

    const responseParts: A2APart[] = textToA2AParts(result.text);

    if (result.structured) {
      responseParts.push({
        kind: "data",
        data: result.structured as Record<string, unknown>,
      });
    }

    const agentMessage: A2AMessage = {
      role: "agent",
      parts: responseParts,
      messageId: randomUUID(),
      taskId,
    };

    task.history!.push(agentMessage);

    if (result.toolCalls?.length) {
      task.artifacts = result.toolCalls.map((tc) => ({
        artifactId: tc.toolCallId,
        name: tc.toolName,
        parts: [
          {
            kind: "text" as const,
            text: typeof tc.result === "string" ? tc.result : tc.result.content,
          },
        ],
      }));
    }

    store.updateState(taskId, "completed", agentMessage);

    const response: A2AJsonRpcResponse = {
      jsonrpc: "2.0",
      id: body.id,
      result: store.get(taskId),
    };

    res.json(response);
  } catch (err: any) {
    const errorMessage: A2AMessage = {
      role: "agent",
      parts: [{ kind: "text", text: `Error: ${err.message}` }],
      taskId,
    };
    store.updateState(taskId, "failed", errorMessage);

    res.json(jsonRpcError(body.id, -32000, err.message));
  }
}

async function handleMessageStream(
  _req: any,
  res: any,
  body: A2AJsonRpcRequest,
  agents: Record<string, Agent>,
  store: TaskStore,
): Promise<void> {
  const params = body.params as any;
  const message: A2AMessage = params?.message;

  if (!message?.parts?.length) {
    return res.json(jsonRpcError(body.id, -32602, "Missing message.parts"));
  }

  const agent = resolveAgent(agents, message);
  if (!agent) {
    return res.json(jsonRpcError(body.id, -32602, "No matching agent found"));
  }

  const taskId = randomUUID();
  const input = a2aPartsToText(message.parts);

  const task: A2ATask = {
    id: taskId,
    sessionId: (params?.sessionId as string) ?? undefined,
    status: { state: "submitted", timestamp: new Date().toISOString() },
    history: [message],
    metadata: { agentName: agent.name },
  };
  store.set(task);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  store.updateState(taskId, "working");
  sendEvent({
    jsonrpc: "2.0",
    id: body.id,
    result: store.get(taskId),
  });

  try {
    let fullText = "";
    for await (const chunk of agent.stream(input, {
      sessionId: task.sessionId,
    })) {
      if (chunk.type === "text") {
        fullText += chunk.text;
        sendEvent({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: taskId,
            status: {
              state: "working",
              message: {
                role: "agent",
                parts: [{ kind: "text", text: chunk.text }],
              },
              timestamp: new Date().toISOString(),
            },
          },
        });
      }
    }

    const agentMessage: A2AMessage = {
      role: "agent",
      parts: textToA2AParts(fullText),
      messageId: randomUUID(),
      taskId,
    };
    task.history!.push(agentMessage);
    store.updateState(taskId, "completed", agentMessage);

    sendEvent({
      jsonrpc: "2.0",
      id: body.id,
      result: store.get(taskId),
    });

    res.end();
  } catch (err: any) {
    const errorMessage: A2AMessage = {
      role: "agent",
      parts: [{ kind: "text", text: `Error: ${err.message}` }],
      taskId,
    };
    store.updateState(taskId, "failed", errorMessage);

    sendEvent({
      jsonrpc: "2.0",
      id: body.id,
      result: store.get(taskId),
    });
    res.end();
  }
}

function handleTasksGet(res: any, body: A2AJsonRpcRequest, store: TaskStore): void {
  const params = body.params as any;
  const taskId = params?.id;

  if (!taskId) {
    return res.json(jsonRpcError(body.id, -32602, "Missing task id"));
  }

  const task = store.get(taskId);
  if (!task) {
    return res.json(jsonRpcError(body.id, -32602, `Task '${taskId}' not found`));
  }

  const historyLength = params?.historyLength as number | undefined;
  const result = { ...task };
  if (historyLength && result.history) {
    result.history = result.history.slice(-historyLength);
  }

  res.json({ jsonrpc: "2.0", id: body.id, result } as A2AJsonRpcResponse);
}

function handleTasksCancel(res: any, body: A2AJsonRpcRequest, store: TaskStore): void {
  const params = body.params as any;
  const taskId = params?.id;

  if (!taskId) {
    return res.json(jsonRpcError(body.id, -32602, "Missing task id"));
  }

  const task = store.get(taskId);
  if (!task) {
    return res.json(jsonRpcError(body.id, -32602, `Task '${taskId}' not found`));
  }

  store.updateState(taskId, "canceled");

  res.json({
    jsonrpc: "2.0",
    id: body.id,
    result: store.get(taskId),
  } as A2AJsonRpcResponse);
}
