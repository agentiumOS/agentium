import type { BrowserAction } from "./types.js";

/**
 * Detects two kinds of "stuck":
 *
 * 1. **Action loops** — the same action (after normalization) repeated too
 *    often in a rolling window. Replaces the v2.0.x exact-string compare
 *    that was easily fooled by tiny wording changes in `description`.
 * 2. **Page stagnation** — the page hasn't changed (URL + interactive-
 *    element count + DOM text hash) for several steps in a row. Useful
 *    for catching cases where the agent keeps clicking but nothing
 *    happens (overlay blocking, dead button).
 *
 * Instead of hard-failing on the first sign of trouble like v2.0.x did,
 * we emit a graduated severity level so the agent loop can:
 *   - 0/`none`     — fine, do nothing
 *   - 1/`warn`     — nudge the model ("you might be repeating yourself")
 *   - 2/`escalate` — stronger nudge ("you're definitely stuck, try a
 *     different approach")
 *   - 3/`abort`    — force termination
 *
 * Thresholds are loosely modelled on browser-use's escalating nudges.
 */
export type LoopSeverity = "none" | "warn" | "escalate" | "abort";

export interface LoopAdvice {
  severity: LoopSeverity;
  message?: string;
}

export interface PageFingerprint {
  url: string;
  interactiveCount: number;
  /** Cheap hash of the first ~1000 chars of visible body text. */
  textHash: number;
}

export class LoopDetector {
  private actionWindow: string[] = [];
  private pageHistory: PageFingerprint[] = [];
  private readonly actionWindowSize: number;
  private readonly pageHistorySize: number;
  /** Thresholds: repeat counts at which each severity fires. */
  private readonly actionThresholds: { warn: number; escalate: number; abort: number };
  /** Thresholds: consecutive unchanged-page counts at which each fires. */
  private readonly pageThresholds: { warn: number; escalate: number; abort: number };

  constructor(opts?: {
    actionWindowSize?: number;
    pageHistorySize?: number;
    actionThresholds?: { warn?: number; escalate?: number; abort?: number };
    pageThresholds?: { warn?: number; escalate?: number; abort?: number };
  }) {
    this.actionWindowSize = opts?.actionWindowSize ?? 20;
    this.pageHistorySize = opts?.pageHistorySize ?? 10;
    this.actionThresholds = {
      warn: opts?.actionThresholds?.warn ?? 5,
      escalate: opts?.actionThresholds?.escalate ?? 8,
      abort: opts?.actionThresholds?.abort ?? 12,
    };
    this.pageThresholds = {
      warn: opts?.pageThresholds?.warn ?? 5,
      escalate: opts?.pageThresholds?.escalate ?? 8,
      abort: opts?.pageThresholds?.abort ?? 12,
    };
  }

  /**
   * Record an action and return advice for the runtime. `severity` of
   * `abort` means the loop should terminate now.
   */
  recordAction(action: BrowserAction): LoopAdvice {
    const key = normalizeAction(action);
    this.actionWindow.push(key);
    if (this.actionWindow.length > this.actionWindowSize) this.actionWindow.shift();

    // Count occurrences of this key in the recent window.
    let count = 0;
    for (const k of this.actionWindow) if (k === key) count++;

    if (count >= this.actionThresholds.abort) {
      return {
        severity: "abort",
        message:
          `Auto-stopped: the action "${key}" has been repeated ${count} times in the last ${this.actionWindow.length} steps with no apparent progress.`,
      };
    }
    if (count >= this.actionThresholds.escalate) {
      return {
        severity: "escalate",
        message:
          `You have repeated essentially the same action ${count} times. The current approach is NOT working — pick a different strategy: scroll, navigate elsewhere, dismiss a popup, or use "fail" if the task truly cannot be done.`,
      };
    }
    if (count >= this.actionThresholds.warn) {
      return {
        severity: "warn",
        message: `You've repeated this action ${count} times — if the page hasn't changed, try a different approach.`,
      };
    }
    return { severity: "none" };
  }

  /**
   * Record a page fingerprint and return advice if the page has been
   * stagnant. Counts consecutive identical fingerprints at the END of
   * the history (so a single navigation resets the counter).
   */
  recordPage(fp: PageFingerprint): LoopAdvice {
    this.pageHistory.push(fp);
    if (this.pageHistory.length > this.pageHistorySize) this.pageHistory.shift();

    let stagnantCount = 1;
    for (let i = this.pageHistory.length - 2; i >= 0; i--) {
      const prev = this.pageHistory[i];
      if (
        prev.url === fp.url &&
        prev.interactiveCount === fp.interactiveCount &&
        prev.textHash === fp.textHash
      ) {
        stagnantCount++;
      } else {
        break;
      }
    }

    if (stagnantCount >= this.pageThresholds.abort) {
      return {
        severity: "abort",
        message: `Auto-stopped: the page hasn't changed in ${stagnantCount} consecutive steps. Likely a blocking overlay or dead control.`,
      };
    }
    if (stagnantCount >= this.pageThresholds.escalate) {
      return {
        severity: "escalate",
        message:
          `The page has not changed in ${stagnantCount} steps. Something is blocking progress — try dismissing popups, navigating elsewhere, or scrolling.`,
      };
    }
    if (stagnantCount >= this.pageThresholds.warn) {
      return {
        severity: "warn",
        message: `Page hasn't changed in ${stagnantCount} steps — verify your action is taking effect.`,
      };
    }
    return { severity: "none" };
  }

  /** Combine two advices, returning the more severe one. */
  static combine(a: LoopAdvice, b: LoopAdvice): LoopAdvice {
    const rank = { none: 0, warn: 1, escalate: 2, abort: 3 } as const;
    return rank[a.severity] >= rank[b.severity] ? a : b;
  }
}

/**
 * Normalize an action for loop comparison. The goal is to canonicalize
 * tiny variations the LLM produces (e.g. different `description`s for
 * the same click) into a single key while keeping actions that are
 * fundamentally different (different `index`, `text`, `url`, …) distinct.
 */
export function normalizeAction(action: BrowserAction): string {
  switch (action.action) {
    case "click":
      // Index dominates if present; otherwise bucket by approximate
      // coordinate (round to nearest 16px tile).
      if (typeof action.index === "number") return `click:${action.index}`;
      if (typeof action.x === "number" && typeof action.y === "number") {
        return `click:xy:${Math.round(action.x / 16)},${Math.round(action.y / 16)}`;
      }
      return `click:?`;
    case "type":
      if (typeof action.index === "number") return `type:${action.index}:${truncate(action.text, 40)}`;
      return `type:?:${truncate(action.text, 40)}`;
    case "scroll":
      return `scroll:${action.direction}:${action.amount ?? "default"}${action.index != null ? `:${action.index}` : ""}`;
    case "navigate":
      return `navigate:${action.url}`;
    case "back":
      return "back";
    case "wait":
      // Bucket wait durations into ~1s bands so "wait 1200" and "wait 1500"
      // collapse to the same key.
      return `wait:${Math.round(action.ms / 1000)}`;
    case "screenshot":
      return "screenshot";
    case "send_keys":
      return `send_keys:${action.keys}`;
    case "find_text":
      return `find_text:${truncate(action.text, 40)}`;
    case "evaluate":
      return `evaluate:${truncate(action.code, 80)}`;
    case "dropdown_options":
      return `dropdown_options:${action.index}`;
    case "select_dropdown":
      return `select_dropdown:${action.index}:${truncate(action.text, 40)}`;
    case "upload_file":
      return `upload_file:${action.index}:${action.path}`;
    case "extract":
      return `extract:${truncate(action.query, 80)}`;
    case "tool":
      // For tools, args matter — but lots of tools are deterministic by name alone.
      return `tool:${action.name}`;
    case "done":
    case "fail":
      return action.action;
  }
}

/**
 * Tiny non-cryptographic string hash, stable across runs. Used for the
 * DOM-text portion of `PageFingerprint`.
 */
export function fnvHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
