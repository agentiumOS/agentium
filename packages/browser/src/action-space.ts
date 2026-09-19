import type { BrowserAction, DomElement, SearchEngine } from "./types.js";

export const DEFAULT_MAX_ACTION_CHOICES = 40;

export interface TabInfo {
  id: string;
  url: string;
  active: boolean;
}

export interface ActionSpace {
  /** Jev / TypeSafe choice criteria: label → description. */
  criteria: Record<string, string>;
  toAction(label: string): BrowserAction | undefined;
}

export function searchUrl(query: string, engine: SearchEngine = "duckduckgo"): string {
  const q = encodeURIComponent(query.trim());
  switch (engine) {
    case "google":
      return `https://www.google.com/search?q=${q}`;
    case "bing":
      return `https://www.bing.com/search?q=${q}`;
    default:
      // Lite HTML SERP — duckduckgo.com's JS homepage 418s headless Chromium.
      return `https://html.duckduckgo.com/html/?q=${q}`;
  }
}

export function isSearchResultsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
      return u.searchParams.has("q") || u.pathname.includes("/html");
    }
    if (host === "google.com" || host.endsWith(".google.com")) return u.pathname.startsWith("/search");
    if (host === "bing.com" || host.endsWith(".bing.com")) return u.pathname.startsWith("/search");
    return false;
  } catch {
    return false;
  }
}

/** Bot-block / challenge pages (DDG 418, Google sorry, Cloudflare, …). */
export function isBlockedPageUrl(url: string): boolean {
  return /418\.html|\/sorry\/|captcha|challenge|cf-browser-verification/i.test(url);
}

export function isBotChallengeText(text: string): boolean {
  return /unfortunately, bots use|select all squares containing a duck|unusual traffic from your computer|are you a robot|verify you are human|detected unusual traffic/i.test(
    text,
  );
}

const CHROME_LABEL =
  /^(email us|feedback|privacy|terms|settings|facebook|twitter|reddit|about|help|sign in|log in|login|all regions|any time|more results|next|previous|images|videos|news|maps|shopping|lite|duckduckgo|menu|home|cookies|advertising|github|wikipedia|instagram|youtube)$/i;

export function isResultTitle(label: string): boolean {
  const t = label.replace(/\s+/g, " ").trim();
  if (t.length < 16) return false;
  if (CHROME_LABEL.test(t)) return false;
  if (/^(https?:|javascript:|mailto:)/i.test(t)) return false;
  return true;
}

export function looksLikeResultList(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  return lines.length >= 2 && lines.filter(isResultTitle).length >= 2;
}

/** Longest non-chrome link labels — search result titles, not "email us". */
export function titlesFromElements(elements: DomElement[], max = 5): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const e of elements) {
    if (e.tag !== "a" && e.role !== "link" && e.role !== "heading") continue;
    const label = e.label?.replace(/\s+/g, " ").trim() ?? "";
    if (!isResultTitle(label) || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
  }
  labels.sort((a, b) => b.length - a.length);
  return labels
    .slice(0, max)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");
}

export const SERP_TITLE_SELECTORS = ["a.result__a", "a.result-link", "#links .result__a", "h2 a", "h3 a", "a > h3"];

export function guessSearchQuery(task: string): string {
  const quoted = task.match(/["']([^"']{1,200})["']/);
  if (quoted?.[1]) return quoted[1].trim();
  return task
    .replace(/^(please\s+)?(search for|google|bing|find|look up)\s+/i, "")
    .slice(0, 200)
    .trim();
}

/**
 * Closed action list for this frame: chrome (back, scroll, done, …) plus
 * `click_N` / `type_N` from the DOM snapshot. Used by the Jev planner and
 * as documentation of what `executeAction` can run without free-form JSON.
 */
export function buildActionSpace(
  elements: DomElement[],
  tabs: TabInfo[] = [],
  opts?: {
    max?: number;
    pagesBelow?: number;
    pagesAbove?: number;
    allowSearch?: boolean;
    allowDone?: boolean;
    allowWait?: boolean;
  },
): ActionSpace {
  const max = opts?.max ?? DEFAULT_MAX_ACTION_CHOICES;
  const criteria: Record<string, string> = {
    back: "Go to the previous page",
    screenshot: "Take a fresh screenshot next step",
    fail: "Give up — the task cannot be completed",
    new_tab: "Open a blank new tab",
  };
  if (opts?.allowWait !== false) {
    criteria.wait = "Wait for the page to settle. Use at most once.";
  }
  if (opts?.allowDone !== false) {
    criteria.done = "The task is finished — return the result titles you already found";
  }
  if (opts?.allowSearch !== false) {
    criteria.search = "Open a NEW web search. Do not pick this if results are already on screen.";
  }
  if ((opts?.pagesBelow ?? 1) > 0) {
    criteria.scroll_down = "Scroll down one viewport";
  }
  if ((opts?.pagesAbove ?? 1) > 0) {
    criteria.scroll_up = "Scroll up one viewport";
  }

  const slice = elements.slice(0, max);
  for (const e of slice) {
    const label = e.label?.trim() || e.role || e.tag;
    criteria[`click_${e.index}`] = `Click [${e.index}] ${e.role}: ${label}`;
    if (e.isInput) {
      criteria[`type_${e.index}`] = `Type into [${e.index}] ${label}`;
    }
  }

  for (const tab of tabs) {
    if (!tab.active) {
      criteria[`switch_tab_${tab.id}`] = `Switch to tab ${tab.id} (${tab.url || "blank"})`;
    }
    if (tabs.length > 1) {
      criteria[`close_tab_${tab.id}`] = `Close tab ${tab.id}`;
    }
  }

  return {
    criteria,
    toAction(label: string): BrowserAction | undefined {
      return labelToAction(label);
    },
  };
}

export function labelToAction(
  label: string,
  extras?: { typeText?: string; searchQuery?: string; doneResult?: string },
): BrowserAction | undefined {
  if (label === "back") return { action: "back" };
  if (label === "scroll_down") return { action: "scroll", direction: "down" };
  if (label === "scroll_up") return { action: "scroll", direction: "up" };
  if (label === "wait") return { action: "wait", ms: 1500 };
  if (label === "screenshot") return { action: "screenshot" };
  if (label === "done") return { action: "done", result: extras?.doneResult ?? "Done" };
  if (label === "fail") return { action: "fail", reason: "Jev chose fail" };
  if (label === "search") return { action: "search", query: extras?.searchQuery ?? "" };
  if (label === "new_tab") return { action: "new_tab" };
  if (label === "none") return undefined;

  const click = /^click_(\d+)$/.exec(label);
  if (click) return { action: "click", index: Number(click[1]) };

  const type = /^type_(\d+)$/.exec(label);
  if (type) return { action: "type", index: Number(type[1]), text: extras?.typeText ?? "" };

  const sw = /^switch_tab_(.+)$/.exec(label);
  if (sw) return { action: "switch_tab", tabId: sw[1] };

  const cl = /^close_tab_(.+)$/.exec(label);
  if (cl) return { action: "close_tab", tabId: cl[1] };

  return undefined;
}
