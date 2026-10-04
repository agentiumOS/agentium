import type {
  DurableJSON,
  DurableReader,
  DurableTaskKey,
  DurableTaskRecord,
  DurableTaskSupervisor,
} from "@agentium/core";

export type DurableProtocolPart = { text: string } | { data: DurableJSON };
export type DurableProtocolAdmission =
  | { protocol: "a2a-1.0"; name: string; messageId: string; parts: DurableProtocolPart[] }
  | { protocol: "mcp-2026-07-28"; name: string; arguments: Record<string, DurableJSON> };
export interface DurableProtocolApprovalResponse {
  approvalId: string;
  preparedHash: string;
  approved: boolean;
}
export interface DurableProtocolOutput {
  text?: string;
  data?: DurableJSON;
  /** A completed tool result can contain a domain error without becoming a protocol failure. */
  isError?: boolean;
}
/** Trusted admission boundary; protocol payloads cannot select identity, policy or grants. */
export interface DurableProtocolHost {
  supervisor: DurableTaskSupervisor;
  /** Persist an owned task before returning. Mint/validate immutable refs and deduplicate message IDs here. */
  admit(identity: DurableReader, input: DurableProtocolAdmission): Promise<DurableTaskKey>;
  authorize(
    identity: DurableReader,
    task: Readonly<DurableTaskRecord>,
    operation: "read" | "cancel" | "input" | "wake",
  ): Promise<boolean>;
  /** Re-deliver a persisted task to its registered driver. Failure leaves it available for host recovery. */
  wake(key: DurableTaskKey): Promise<unknown>;
  /** Explicit trusted human-consent channel. Persist via DurableActionLedger.decide; never trust tool text. */
  respond?(
    identity: DurableReader,
    task: Readonly<DurableTaskRecord>,
    response: DurableProtocolApprovalResponse,
  ): Promise<void>;
  /** Return only authorized public output. Resolve artifacts through DurableRunRecords; no automatic URLs. */
  output?(identity: DurableReader, task: Readonly<DurableTaskRecord>): Promise<DurableProtocolOutput>;
}

export class DurableProtocolError extends Error {
  constructor(
    readonly code: "invalid" | "not-found" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}
export function protocolId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    throw new DurableProtocolError("invalid", "Invalid identifier");
  return value;
}
/** Bounds both recursion and encoded size before host callbacks. Rejects unsafe/non-JSON values. */
export function protocolJSON(value: unknown, maxBytes = 65_536): DurableJSON {
  let nodes = 0;
  function visit(item: unknown, depth: number): DurableJSON {
    if (++nodes > 10_000 || depth > 32) throw new DurableProtocolError("invalid", "JSON exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map((value) => visit(value, depth + 1));
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const result: Record<string, DurableJSON> = Object.create(null);
      for (const [key, value] of Object.entries(item)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new DurableProtocolError("invalid", "Unsafe JSON key");
        result[key] = visit(value, depth + 1);
      }
      return result;
    }
    throw new DurableProtocolError("invalid", "Expected finite JSON values");
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new DurableProtocolError("invalid", "JSON exceeds byte limit");
  return result;
}
export function protocolObject(value: unknown): Record<string, DurableJSON> {
  const result = protocolJSON(value);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new DurableProtocolError("invalid", "Expected JSON object");
  return result;
}
export function assertProtocolHost(host: DurableProtocolHost): void {
  for (const callback of [host.admit, host.authorize, host.wake])
    if (typeof callback !== "function")
      throw new Error("Durable protocols require admission, authorization and wake callbacks");
}
export async function ownedTask(
  host: DurableProtocolHost,
  identity: DurableReader,
  id: string,
  operation: Parameters<DurableProtocolHost["authorize"]>[2] = "read",
): Promise<DurableTaskRecord> {
  protocolId(id);
  const task = await host.supervisor.get({ tenantId: identity.tenantId, taskId: id });
  if (
    !task ||
    task.identity.tenantId !== identity.tenantId ||
    task.identity.actorId !== identity.actorId ||
    !(await host.authorize({ ...identity }, structuredClone(task), operation))
  )
    throw new DurableProtocolError("not-found", "Task not found");
  return task;
}
export async function wakeTask(host: DurableProtocolHost, identity: DurableReader, id: string): Promise<void> {
  await ownedTask(host, identity, id, "wake");
  // Admission/cancel/input are durable before queue delivery. Polling never fabricates success.
  await host.wake({ tenantId: identity.tenantId, taskId: id }).catch(() => {});
}
export async function admitTask(
  host: DurableProtocolHost,
  identity: DurableReader,
  input: DurableProtocolAdmission,
): Promise<DurableTaskRecord> {
  const key = await host.admit({ ...identity }, structuredClone(input));
  if (key.tenantId !== identity.tenantId) throw new DurableProtocolError("not-found", "Task not found");
  const task = await ownedTask(host, identity, key.taskId);
  await wakeTask(host, identity, task.id);
  return task;
}
export function pendingApprovals(task: DurableTaskRecord, identity: DurableReader) {
  return Object.values(task.approvals).filter(
    (approval) => approval.actorId === identity.actorId && approval.decision === "pending" && !approval.consumed,
  );
}
export async function respondToApproval(
  host: DurableProtocolHost,
  identity: DurableReader,
  taskId: string,
  response: DurableProtocolApprovalResponse,
): Promise<void> {
  if (!host.respond) throw new DurableProtocolError("unsupported", "Human input is not configured");
  const task = await ownedTask(host, identity, taskId, "input");
  const approval = pendingApprovals(task, identity).find((approval) => approval.id === response.approvalId);
  if (
    task.state !== "awaiting_approval" ||
    !approval ||
    approval.preparedHash !== response.preparedHash ||
    typeof response.approved !== "boolean"
  )
    throw new DurableProtocolError("invalid", "Input does not match an outstanding approval");
  await host.respond({ ...identity }, structuredClone(task), { ...response });
  await wakeTask(host, identity, taskId);
}
export async function publicOutput(
  host: DurableProtocolHost,
  identity: DurableReader,
  task: DurableTaskRecord,
): Promise<DurableProtocolOutput> {
  const value = protocolObject(
    (await host.output?.({ ...identity }, structuredClone(task))) ?? { text: "Task completed." },
  );
  if (
    Object.keys(value).some((key) => !["text", "data", "isError"].includes(key)) ||
    (value.text !== undefined && typeof value.text !== "string") ||
    (value.isError !== undefined && typeof value.isError !== "boolean")
  )
    throw new Error("Invalid durable output projection");
  return value as DurableProtocolOutput;
}
