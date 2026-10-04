import type { ChatMessage } from "@agentium/core";
import { countTokens, RunCancelledError, RunContext } from "@agentium/core";
import type { HarnessContextBudget, HarnessContextEntry, HarnessContextSource } from "./types.js";

export interface HarnessContextDiagnostic {
  sourceId: string;
  entryId?: string;
  code: "expired" | "invalid" | "truncated" | "budget" | "deadline" | "failed" | "trust_downgraded";
  message: string;
}

const DEFAULT_BUDGET: HarnessContextBudget = {
  maxEntries: 32,
  maxBytes: 64 * 1024,
  maxTokens: 16_000,
  deadlineMs: 5000,
};

function sourceMessage(sourceId: string, entry: HarnessContextEntry, text: string): ChatMessage {
  const provenance = {
    version: 1,
    sourceId,
    entryId: entry.id,
    trust: "source",
    ...(entry.source
      ? {
          source: {
            uri: entry.source.uri,
            ...(entry.source.version === undefined ? {} : { version: entry.source.version }),
            ...(entry.source.locator === undefined ? {} : { locator: entry.source.locator }),
          },
        }
      : {}),
  };
  return {
    role: "user",
    content: JSON.stringify({ kind: "harness-source-data", ...provenance, text }),
    providerExtras: { harnessContext: provenance },
  };
}

/** All limits apply across every source. Tokens are centrally estimated, never accepted from the source. */
export async function fetchHarnessContext(
  sources: readonly HarnessContextSource[],
  query: string,
  ctx: RunContext,
  configured?: Partial<HarnessContextBudget>,
): Promise<{ messages: ChatMessage[]; diagnostics: HarnessContextDiagnostic[] }> {
  const budget = { ...DEFAULT_BUDGET, ...configured };
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0))
      throw new Error(`Invalid harness context budget: ${key}`);
  }
  const messages: ChatMessage[] = [];
  const diagnostics: HarnessContextDiagnostic[] = [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (typeof source.id !== "string" || !source.id || sourceIds.has(source.id))
      throw new Error("Harness context source IDs must be nonempty and unique");
    sourceIds.add(source.id);
  }
  const deadline = Date.now() + budget.deadlineMs;
  let bytes = 0;
  let tokens = 0;
  for (const source of sources) {
    if (ctx.signal?.aborted) throw new RunCancelledError();
    const remaining: HarnessContextBudget = {
      maxEntries: budget.maxEntries - messages.length,
      maxBytes: budget.maxBytes - bytes,
      ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens - tokens }),
      deadlineMs: Math.max(0, deadline - Date.now()),
    };
    if (!remaining.maxEntries || !remaining.maxBytes || remaining.maxTokens === 0 || !remaining.deadlineMs) {
      diagnostics.push({
        sourceId: source.id,
        code: remaining.deadlineMs ? "budget" : "deadline",
        message: "Shared context retrieval budget exhausted",
      });
      break;
    }
    const controller = new AbortController();
    const childCtx = new RunContext({
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      metadata: ctx.metadata,
      eventBus: ctx.eventBus,
      sessionState: ctx.sessionState,
      dependencies: ctx.dependencies,
      questions: ctx.questions,
      executionPolicy: ctx.executionPolicy,
      runMode: ctx.runMode,
      signal: controller.signal,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let entries: readonly HarnessContextEntry[];
    try {
      entries = await Promise.race([
        Promise.resolve().then(() => {
          if (childCtx.signal?.aborted || ctx.signal?.aborted) throw new RunCancelledError();
          return source.fetch(query, childCtx, remaining);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("deadline"));
          }, remaining.deadlineMs);
          abort = () => {
            controller.abort();
            reject(new RunCancelledError());
          };
          ctx.signal?.addEventListener("abort", abort, { once: true });
          if (ctx.signal?.aborted) abort();
        }),
      ]);
    } catch {
      if (ctx.signal?.aborted) throw new RunCancelledError();
      diagnostics.push({
        sourceId: source.id,
        code: controller.signal.aborted ? "deadline" : "failed",
        message: "Context source could not complete within its budget",
      });
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) ctx.signal?.removeEventListener("abort", abort);
    }
    if (!Array.isArray(entries)) {
      diagnostics.push({ sourceId: source.id, code: "invalid", message: "Context source must return an array" });
      continue;
    }
    if (entries.length > remaining.maxEntries)
      diagnostics.push({
        sourceId: source.id,
        code: "budget",
        message: "Context entries beyond the shared entry limit were discarded",
      });
    const entryIds = new Set<string>();
    for (const entry of entries.slice(0, remaining.maxEntries)) {
      if (ctx.signal?.aborted) throw new RunCancelledError();
      if (Date.now() >= deadline) {
        diagnostics.push({
          sourceId: source.id,
          code: "deadline",
          message: "Shared context retrieval deadline expired",
        });
        break;
      }
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id ||
        entryIds.has(entry.id) ||
        typeof entry.text !== "string" ||
        (entry.expiresAt !== undefined && !Number.isFinite(entry.expiresAt))
      ) {
        diagnostics.push({
          sourceId: source.id,
          code: "invalid",
          message: "Invalid or duplicate context entry was discarded",
        });
        continue;
      }
      if (
        entry.source &&
        (typeof entry.source.uri !== "string" ||
          (entry.source.version !== undefined && typeof entry.source.version !== "string") ||
          (entry.source.locator !== undefined && typeof entry.source.locator !== "string"))
      ) {
        diagnostics.push({
          sourceId: source.id,
          entryId: entry.id,
          code: "invalid",
          message: "Invalid context source provenance was discarded",
        });
        continue;
      }
      entryIds.add(entry.id);
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        diagnostics.push({
          sourceId: source.id,
          entryId: entry.id,
          code: "expired",
          message: "Expired context entry was discarded",
        });
        continue;
      }
      if (entry.trust !== "source")
        diagnostics.push({
          sourceId: source.id,
          entryId: entry.id,
          code: "trust_downgraded",
          message: "Retrieved context is always source data; host trust declarations are ignored",
        });
      const fits = (message: ChatMessage): boolean => {
        const text = message.content as string;
        return (
          Buffer.byteLength(text, "utf8") <= budget.maxBytes - bytes &&
          (budget.maxTokens === undefined || countTokens(text) <= budget.maxTokens - tokens)
        );
      };
      let message = sourceMessage(source.id, entry, entry.text);
      if (!fits(message)) {
        if (!fits(sourceMessage(source.id, entry, ""))) {
          diagnostics.push({
            sourceId: source.id,
            entryId: entry.id,
            code: "budget",
            message: "Context entry metadata exceeds the remaining budget",
          });
          continue;
        }
        let low = 0;
        let high = entry.text.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(sourceMessage(source.id, entry, entry.text.slice(0, middle)))) low = middle;
          else high = middle - 1;
        }
        if (low > 0 && /[\uD800-\uDBFF]/.test(entry.text[low - 1])) low--;
        message = sourceMessage(source.id, entry, entry.text.slice(0, low));
        diagnostics.push({
          sourceId: source.id,
          entryId: entry.id,
          code: "truncated",
          message: "Context text truncated to the shared byte/token budget (tokens estimated)",
        });
      }
      messages.push(message);
      bytes += Buffer.byteLength(message.content as string, "utf8");
      tokens += countTokens(message.content as string);
    }
  }
  return { messages, diagnostics };
}
