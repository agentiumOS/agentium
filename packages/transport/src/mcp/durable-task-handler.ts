import type { DurableReader, DurableTaskRecord } from "@agentium/core";
import {
  admitTask,
  assertProtocolHost,
  DurableProtocolError,
  type DurableProtocolHost,
  ownedTask,
  pendingApprovals,
  protocolId,
  protocolObject,
  publicOutput,
  respondToApproval,
  wakeTask,
} from "../durable/protocol-host.js";

const VERSION = "2026-07-28";
const EXTENSION = "io.modelcontextprotocol/tasks";
export interface DurableMCPTaskTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface DurableMCPTaskHandlerOptions extends DurableProtocolHost {
  name: string;
  audience: string;
  authenticate(request: Request, audience: string): Promise<DurableReader | null>;
  tools: readonly DurableMCPTaskTool[];
  pollIntervalMs?: number;
}
export interface DurableMCPTaskHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Pinned modern HTTP/Tasks extension adapter. SDK handles discovery/schema framing;
 * task extension methods are explicitly implemented here, not by the base SDK.
 * The modern protocol negotiates capabilities in each validated request envelope.
 */
export async function createDurableMCPTaskHandler(
  options: DurableMCPTaskHandlerOptions,
): Promise<DurableMCPTaskHandler> {
  assertProtocolHost(options);
  protocolId(options.name);
  if (typeof options.authenticate !== "function" || !options.audience)
    throw new Error("Verified authentication and audience are required");
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60_000)
    throw new Error("Invalid polling interval");
  const sdk = await import("@modelcontextprotocol/server");
  const tools = new Map(
    options.tools.map((tool) => {
      protocolId(tool.name);
      if (!/^[a-zA-Z0-9_.-]+$/.test(tool.name)) throw new Error("Invalid MCP tool name");
      const definition = {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: protocolObject(tool.inputSchema),
      };
      if (definition.inputSchema.type !== "object") throw new Error("MCP tools require an object input schema");
      return [tool.name, { definition, schema: sdk.fromJsonSchema(definition.inputSchema) }] as const;
    }),
  );
  if (!tools.size || tools.size > 128 || tools.size !== options.tools.length)
    throw new Error("Provide 1–128 uniquely named tools");
  const base = sdk.createMcpHandler(
    () => {
      const server = new sdk.McpServer(
        { name: options.name, version: "3.2.0" },
        { capabilities: { extensions: { [EXTENSION]: {} } } },
      );
      for (const { definition, schema } of tools.values())
        server.registerTool(definition.name, { description: definition.description, inputSchema: schema }, async () => {
          throw new Error("Tasks negotiation required");
        });
      return server;
    },
    { legacy: "reject", maxRequestBodySize: 65_536 },
  );
  const headers = { "Cache-Control": "no-store", "MCP-Protocol-Version": VERSION };
  const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result }, { headers });
  const fail = (id: unknown, code: number, message: string, status = 200, data?: unknown) =>
    Response.json(
      { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } },
      { status, headers },
    );
  async function view(task: DurableTaskRecord, who: DurableReader, resultType: "task" | "complete") {
    const approvals = pendingApprovals(task, who);
    const status = {
      queued: "working",
      running: "working",
      cancel_requested: "working",
      awaiting_approval: approvals.length ? "input_required" : "working",
      completed: "completed",
      canceled: "cancelled",
      failed: "failed",
      stopped: "failed",
    }[task.state];
    const result: Record<string, unknown> = {
      resultType,
      taskId: task.id,
      status,
      createdAt: new Date(task.createdAt).toISOString(),
      lastUpdatedAt: new Date(task.updatedAt).toISOString(),
      ttlMs: null,
      pollIntervalMs,
    };
    if (status === "input_required")
      result.inputRequests = Object.fromEntries(
        approvals.map((approval) => [
          approval.id,
          {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Approve the pending action through the configured human consent channel.",
              requestedSchema: {
                type: "object",
                properties: {
                  approved: { type: "boolean" },
                  preparedHash: { type: "string", enum: [approval.preparedHash] },
                },
                required: ["approved", "preparedHash"],
              },
            },
          },
        ]),
      );
    if (task.state === "completed") {
      const output = await publicOutput(options, who, task);
      result.result = {
        resultType: "complete",
        content: output.text !== undefined ? [{ type: "text", text: output.text }] : [],
        ...(output.data !== undefined ? { structuredContent: { value: output.data } } : {}),
        isError: output.isError ?? false,
      };
    }
    if (status === "failed")
      result.error = { code: -32603, message: task.state === "stopped" ? "Task stopped" : "Task failed" };
    return protocolObject(result);
  }
  return {
    close: () => base.close(),
    async fetch(request) {
      let id: unknown = null;
      try {
        const who = await options.authenticate(request, options.audience);
        if (!who?.tenantId || !who.actorId) return fail(id, -32001, "Authentication required", 401);
        protocolId(who.tenantId);
        protocolId(who.actorId);
        if (request.method !== "POST") return fail(id, -32600, "POST required", 405);
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
          return fail(id, -32600, "JSON content type required", 415);
        const bodyRead = await sdk.readRequestBody(request, 65_536);
        if (bodyRead.tooLarge) return fail(id, -32600, "Request exceeds byte limit", 413);
        let raw: unknown;
        try {
          raw = JSON.parse(bodyRead.text);
        } catch {
          return fail(id, -32700, "Invalid JSON", 400);
        }
        const body = protocolObject(raw);
        id = body.id;
        const classification = sdk.classifyInboundRequest({
          httpMethod: request.method,
          body,
          protocolVersionHeader: request.headers.get("MCP-Protocol-Version") ?? undefined,
          mcpMethodHeader: request.headers.get("Mcp-Method") ?? undefined,
          mcpNameHeader: request.headers.get("Mcp-Name") ?? undefined,
        });
        if (classification.kind === "reject")
          return fail(id, classification.code, classification.message, classification.httpStatus, classification.data);
        if (classification.kind !== "modern") return base.fetch(request, { parsedBody: body });
        const method = classification.message.method;
        if (!["tools/call", "tasks/get", "tasks/update", "tasks/cancel"].includes(method)) {
          if (["server/discover", "tools/list", "ping"].includes(method))
            return base.fetch(request, { parsedBody: body });
          return fail(id, -32601, "Method not supported by this durable endpoint");
        }
        if (classification.messageKind !== "request")
          return fail(null, -32600, "Task operations require request IDs", 400);
        const params = protocolObject(body.params ?? {});
        const meta = protocolObject(params._meta ?? {});
        if (
          meta["io.modelcontextprotocol/protocolVersion"] !== VERSION ||
          request.headers.get("MCP-Protocol-Version") !== VERSION ||
          request.headers.get("Mcp-Method") !== method
        )
          return fail(id, -32020, "Protocol/header mismatch", 400);
        const name = method === "tools/call" ? protocolId(params.name) : protocolId(params.taskId);
        if (request.headers.get("Mcp-Name") !== encodeURIComponent(name))
          return fail(id, -32020, "Task/name header mismatch", 400);
        const caps = protocolObject(meta["io.modelcontextprotocol/clientCapabilities"] ?? {});
        const extensions = protocolObject(caps.extensions ?? {});
        if (!extensions[EXTENSION] || typeof extensions[EXTENSION] !== "object" || Array.isArray(extensions[EXTENSION]))
          return fail(id, -32021, "Missing required client capability", 200, {
            requiredCapabilities: { extensions: { [EXTENSION]: {} } },
          });
        if (method === "tools/call") {
          if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key)))
            throw new DurableProtocolError("invalid", "Unsupported task creation parameters");
          const tool = tools.get(name);
          if (!tool) throw new DurableProtocolError("invalid", "Unknown tool");
          const args = protocolObject(params.arguments ?? {});
          const validation = await tool.schema["~standard"].validate(args);
          if (validation.issues) throw new DurableProtocolError("invalid", "Invalid tool arguments");
          const task = await admitTask(options, who, {
            protocol: "mcp-2026-07-28",
            name,
            arguments: protocolObject(validation.value),
          });
          return reply(id, await view(task, who, "task"));
        }
        if (
          Object.keys(params).some(
            (key) => !["taskId", "_meta", ...(method === "tasks/update" ? ["inputResponses"] : [])].includes(key),
          )
        )
          throw new DurableProtocolError("invalid", "Unsupported task parameters");
        const task = await ownedTask(
          options,
          who,
          name,
          method === "tasks/cancel" ? "cancel" : method === "tasks/update" ? "input" : "read",
        );
        if (method === "tasks/get") return reply(id, await view(task, who, "complete"));
        if (method === "tasks/cancel") {
          await options.supervisor.cancel({ tenantId: who.tenantId, taskId: task.id });
          await wakeTask(options, who, task.id);
          return reply(id, { resultType: "complete" });
        }
        const responses = protocolObject(params.inputResponses);
        if (!options.respond) throw new DurableProtocolError("unsupported", "Human input is not configured");
        const pending = new Map(pendingApprovals(task, who).map((approval) => [approval.id, approval]));
        // Validate the entire batch before accepting any decision. Unknown/already answered keys are ignored.
        const accepted = Object.entries(responses)
          .filter(([key]) => pending.has(key))
          .map(([approvalId, raw]) => {
            const result = protocolObject(raw);
            if (!["accept", "decline", "cancel"].includes(String(result.action)))
              throw new DurableProtocolError("invalid", "Invalid elicitation response");
            const approval = pending.get(approvalId)!;
            if (result.action !== "accept") return { approvalId, preparedHash: approval.preparedHash, approved: false };
            const content = protocolObject(result.content);
            if (typeof content.approved !== "boolean" || content.preparedHash !== approval.preparedHash)
              throw new DurableProtocolError("invalid", "Approval content does not match prepared action");
            return { approvalId, preparedHash: approval.preparedHash, approved: content.approved };
          });
        for (const response of accepted) await respondToApproval(options, who, task.id, response);
        return reply(id, { resultType: "complete" });
      } catch (error) {
        if (error instanceof DurableProtocolError)
          return fail(
            id,
            error.code === "not-found" ? -32602 : error.code === "unsupported" ? -32601 : -32602,
            error.message,
          );
        return fail(id, -32603, "Durable task operation failed");
      }
    },
  };
}
