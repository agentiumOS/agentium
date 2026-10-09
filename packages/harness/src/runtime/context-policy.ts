import type { ChatMessage, RunContext } from "@agentium/core";
import { validateHarnessMessages } from "./middleware.js";
import type { HarnessContextEntry } from "./types.js";

export interface ContextProjection {
  messages: ChatMessage[];
  provenance: readonly { sourceId: string; included: boolean; reason?: string }[];
}
export interface ContextPolicy {
  id: string;
  grouping?: import("@agentium/core").ConversationGrouping;
  project: (
    input: { history: readonly ChatMessage[]; entries: readonly HarnessContextEntry[] },
    ctx: RunContext,
  ) => Promise<ContextProjection>;
}
/** Request projections never mutate the canonical history. */
export async function projectHarnessContext(
  policy: ContextPolicy | undefined,
  history: readonly ChatMessage[],
  ctx: RunContext,
  entries: readonly HarnessContextEntry[] = [],
): Promise<ContextProjection> {
  const original = structuredClone(history) as ChatMessage[];
  if (!policy) return { messages: original, provenance: [] };
  const result = await policy.project({ history: structuredClone(original), entries: structuredClone(entries) }, ctx);
  validateHarnessMessages(original, result.messages, policy.grouping);
  if (
    !Array.isArray(result.provenance) ||
    result.provenance.some(
      (item) =>
        !item ||
        typeof item.sourceId !== "string" ||
        typeof item.included !== "boolean" ||
        (item.reason !== undefined && typeof item.reason !== "string"),
    )
  )
    throw new Error("Context policy must return provenance");
  return { messages: structuredClone(result.messages), provenance: structuredClone(result.provenance) };
}
