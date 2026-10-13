import type { ChatMessage, RunContext } from "@agentium/core";
import { continuitySourceMessages } from "../continuity-policies.js";
import { validateHarnessMessages } from "./middleware.js";
import type { RecallResult } from "./recall.js";
import type { TaskSummaryRecord } from "./task-summary.js";
import type { HarnessContextEntry } from "./types.js";

export interface ContextProjection {
  messages: ChatMessage[];
  provenance: readonly { sourceId: string; included: boolean; reason?: string }[];
}
export interface ContextPolicy {
  id: string;
  grouping?: import("@agentium/core").ConversationGrouping;
  project: (
    input: {
      history: readonly ChatMessage[];
      entries: readonly HarnessContextEntry[];
      recall?: RecallResult;
      taskSummary?: TaskSummaryRecord;
    },
    ctx: RunContext,
  ) => Promise<ContextProjection>;
}
/** Request projections never mutate the canonical history. */
export async function projectHarnessContext(
  policy: ContextPolicy | undefined,
  history: readonly ChatMessage[],
  ctx: RunContext,
  entries: readonly HarnessContextEntry[] = [],
  continuity: { recall?: RecallResult; taskSummary?: TaskSummaryRecord } = {},
): Promise<ContextProjection> {
  const original = structuredClone(history) as ChatMessage[];
  if (!policy) return { messages: original, provenance: [] };
  const result = await policy.project(
    { history: structuredClone(original), entries: structuredClone(entries), ...structuredClone(continuity) },
    ctx,
  );
  const allowed = continuitySourceMessages(policy.id, continuity.recall, continuity.taskSummary);
  const addedSources = result.messages.filter(
    (message) =>
      message.providerExtras?.harnessContext &&
      !original.some((item) => JSON.stringify(item) === JSON.stringify(message)),
  );
  if (addedSources.some((message) => !allowed.some((item) => JSON.stringify(item.message) === JSON.stringify(message))))
    throw new Error("Context policy introduced unauthorized continuity source data");
  const firstSource = original.findIndex((message) => message.role !== "system");
  const baseline = [...original];
  baseline.splice(firstSource < 0 ? baseline.length : firstSource, 0, ...addedSources);
  validateHarnessMessages(baseline, result.messages, policy.grouping);
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
