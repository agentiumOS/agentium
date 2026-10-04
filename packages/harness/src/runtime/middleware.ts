import type { RunContext } from "@agentium/core";
import { validateConversationTransform } from "@agentium/core";

export { validateConversationTransform as validateHarnessMessages } from "@agentium/core";

import type { ChatMessage, ModelResponse, ToolCallResult } from "@agentium/core";
import type { HarnessMiddleware } from "./types.js";

/** Stable topological sort; declaration order breaks ties between ready nodes. */
export function sortHarnessMiddleware(middleware: readonly HarnessMiddleware[]): HarnessMiddleware[] {
  const byId = new Map<string, HarnessMiddleware>();
  for (const item of middleware) {
    if (!item.id || byId.has(item.id)) throw new Error("Harness middleware IDs must be nonempty and unique");
    byId.set(item.id, item);
  }
  const edges = new Map(middleware.map((item) => [item.id, new Set<string>()]));
  const degrees = new Map(middleware.map((item) => [item.id, 0]));
  const link = (from: string, to: string): void => {
    if (!byId.has(from) || !byId.has(to)) throw new Error("Harness middleware references an unknown ordering ID");
    if (!edges.get(from)!.has(to)) {
      edges.get(from)!.add(to);
      degrees.set(to, degrees.get(to)! + 1);
    }
  };
  for (const item of middleware) {
    for (const id of item.before ?? []) link(item.id, id);
    for (const id of item.after ?? []) link(id, item.id);
  }
  const result: HarnessMiddleware[] = [];
  const consumed = new Set<string>();
  while (result.length < middleware.length) {
    const item = middleware.find((candidate) => !consumed.has(candidate.id) && degrees.get(candidate.id) === 0);
    if (!item) throw new Error("Harness middleware ordering contains a cycle");
    result.push(item);
    consumed.add(item.id);
    for (const id of edges.get(item.id)!) degrees.set(id, degrees.get(id)! - 1);
  }
  return result;
}

export async function runBeforeModel(
  middleware: readonly HarnessMiddleware[],
  messages: readonly ChatMessage[],
  ctx: RunContext,
): Promise<ChatMessage[]> {
  let current = structuredClone(messages) as ChatMessage[];
  for (const item of middleware) {
    ctx.signal?.throwIfAborted();
    if (!item.beforeModel) continue;
    const previous = structuredClone(current);
    const next = await item.beforeModel(current, ctx);
    validateConversationTransform(previous, next);
    current = next;
  }
  return current;
}

export async function runAfterModel(
  middleware: readonly HarnessMiddleware[],
  response: ModelResponse,
  ctx: RunContext,
): Promise<void> {
  for (const item of middleware) {
    ctx.signal?.throwIfAborted();
    await item.afterModel?.(structuredClone(response), ctx);
  }
}

export async function runAfterTool(
  middleware: readonly HarnessMiddleware[],
  result: ToolCallResult,
  ctx: RunContext,
): Promise<void> {
  for (const item of middleware) {
    ctx.signal?.throwIfAborted();
    await item.afterTool?.(structuredClone(result), ctx);
  }
}
