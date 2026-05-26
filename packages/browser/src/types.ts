import type { CostTracker, EventBus, LogLevel, ModelProvider, ToolDef, UnifiedMemoryConfig } from "@agentium/core";
import type { CredentialVault } from "./credential-vault.js";

// ── Browser Actions ──────────────────────────────────────────────────────

/**
 * The complete set of actions a `BrowserAgent` can take during a run.
 *
 * Click / type / scroll accept EITHER an `index` (preferred — resolved
 * against the DOM tree we showed the model) OR `x`/`y` coordinates as a
 * fallback. Indexed actions are far more reliable on dynamic pages because
 * they survive layout shifts, devicePixelRatio mismatches, and "the
 * sibling 4 pixels away" failure modes.
 */
export type BrowserAction =
  | {
      action: "click";
      /** Element index from the DOM snapshot. Preferred. */
      index?: number;
      /** Fallback x coordinate (CSS pixels). */
      x?: number;
      /** Fallback y coordinate (CSS pixels). */
      y?: number;
      /** Free-form description; if it contains a quoted label, used as a text-locator fallback. */
      description?: string;
    }
  | {
      action: "type";
      /** Element index from the DOM snapshot. Preferred. */
      index?: number;
      text: string;
      /** Fallback x coordinate (CSS pixels). */
      x?: number;
      /** Fallback y coordinate (CSS pixels). */
      y?: number;
      /** If true (default), clear the field first. */
      clear?: boolean;
      /** If true (default), press Enter after typing when text ends with `\n`. */
      submit?: boolean;
    }
  | {
      action: "scroll";
      direction: "up" | "down";
      /** Pixels to scroll. Default: 400. */
      amount?: number;
      /** If provided, scroll the element with this index into view instead. */
      index?: number;
    }
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "wait"; ms: number }
  | { action: "screenshot" }
  | { action: "send_keys"; keys: string }
  | { action: "find_text"; text: string }
  | { action: "evaluate"; code: string }
  | { action: "dropdown_options"; index: number }
  | { action: "select_dropdown"; index: number; text: string }
  | { action: "upload_file"; index: number; path: string }
  | {
      action: "extract";
      /** Natural-language description of what to extract. */
      query: string;
      /** Include link hrefs in the extracted content. Default: false. */
      extractLinks?: boolean;
    }
  | {
      action: "tool";
      /** Name of a custom tool registered on the BrowserAgent. */
      name: string;
      args?: Record<string, unknown>;
    }
  | { action: "done"; result: string }
  | { action: "fail"; reason: string };

// ── DOM Snapshot ────────────────────────────────────────────────────────

/**
 * One entry in the DOM snapshot the model sees. Returned by
 * `BrowserProvider.extractDOM()` alongside the human-readable string form.
 */
export interface DomElement {
  /** Stable 1-based index for this step. Used by indexed actions. */
  index: number;
  /** Center coordinate in CSS pixels (fallback for the model if needed). */
  cx: number;
  cy: number;
  /** ARIA role or tag name. */
  role: string;
  /** Input type, if applicable. */
  type?: string;
  /** Visible label (text / aria-label / placeholder / href / …). */
  label: string;
  /** Tag name. */
  tag: string;
  /** Whether it's an `<input>` / `<textarea>` / `[contenteditable]`. */
  isInput: boolean;
  /** Whether it's a `<select>`. */
  isSelect: boolean;
  /** Whether it's an `<input type="file">`. */
  isFile: boolean;
  /** Origin frame (`"main"` or the iframe `src`/path). */
  frame?: string;
}

/**
 * Scroll-context metadata returned alongside `DomElement[]`. Gives the
 * model spatial awareness so it can decide when to scroll vs when more
 * content is below / above the fold.
 */
export interface DomScrollContext {
  /** Approximate viewports of scrollable content above the current view. */
  pagesAbove: number;
  /** Approximate viewports of scrollable content below the current view. */
  pagesBelow: number;
  /** Total interactive elements found (visible + hidden combined). */
  totalInteractive: number;
  /** Count of interactive elements that exist on the page but aren't in the viewport. */
  hiddenInteractive: number;
}

/** Combined return value of `BrowserProvider.extractDOM()`. */
export interface DomSnapshot {
  /** Human-readable string fed to the model. */
  text: string;
  /** Structured list (stable indices) for runtime resolution. */
  elements: DomElement[];
  /** Spatial/scroll context. */
  scroll: DomScrollContext;
}

// ── Config ───────────────────────────────────────────────────────────────

export interface BrowserAgentConfig {
  name: string;
  /** Vision-capable model (GPT-4o, Gemini, etc.) */
  model: ModelProvider;
  /**
   * Optional secondary (usually cheaper) model used for the `extract`
   * action and other text-only sub-tasks. Falls back to `model`.
   */
  pageExtractionLLM?: ModelProvider;
  /**
   * Fallback model used automatically when the primary `model` returns a
   * rate-limit / auth / 5xx error or fails to produce valid JSON several
   * times in a row. Failure-budget aware. Leave unset to disable.
   */
  fallbackModel?: ModelProvider;
  /**
   * Ask the model to emit a structured thinking/evaluation/memory/next_goal
   * envelope around its action(s). Significantly improves accuracy and
   * self-correction on multi-step tasks. Default: `true`. Set `false` for
   * a `flash_mode` that just returns the raw action(s) — useful for very
   * fast / cheap models that are bad at long outputs.
   */
  useThinking?: boolean;
  /**
   * Maximum number of recent step turns kept verbatim in the conversation
   * history sent to the model. Older turns are compacted into a single
   * summary line. Default: 6. Set 0 to disable conversation history
   * entirely (each step rebuilt from scratch — v2.0 behaviour).
   */
  historyWindow?: number;
  /** Extra instructions appended to the default system prompt. */
  instructions?: string;
  /**
   * Append additional instructions to the default system prompt.
   * Alias for `instructions` (browser-use parity). Both are concatenated.
   */
  extendSystemMessage?: string;
  /**
   * Completely replace the default system prompt with this string.
   * The credentials / DOM / coordinate sections are still appended at the
   * end automatically. Most users should use `instructions` instead.
   */
  overrideSystemMessage?: string;
  /** Max vision loop iterations. Default: 30 */
  maxSteps?: number;
  /**
   * Maximum number of consecutive step failures (action threw, invalid
   * JSON from model, locator timeout) before the agent gives up. Default: 3.
   */
  maxFailures?: number;
  /**
   * Maximum number of actions the model can return in a single step.
   * If the model returns an array, we execute them in order until the page
   * navigates or the DOM changes substantially. Default: 3.
   * Set to 1 to force one-action-per-step (the v2.0.x behaviour).
   */
  maxActionsPerStep?: number;
  /**
   * Actions to run before the LLM loop starts. Useful for boilerplate
   * (cookie-banner click, login flow, scrolling) you already know the
   * answer to — saves vision tokens.
   */
  initialActions?: BrowserAction[];
  /**
   * Vision mode. Default: `"auto"`.
   * - `true`: always send a screenshot with every step (v2.0.x behaviour).
   * - `false`: never send screenshots; DOM-only operation.
   * - `"auto"`: send a screenshot on the first step and whenever the model
   *   used the `screenshot` action in the previous step. Saves vision
   *   tokens dramatically on DOM-only-suitable workloads.
   */
  useVision?: boolean | "auto";
  /**
   * If true (default), detect a URL in the task string and navigate to it
   * before the first LLM call — saves one round trip on simple tasks.
   */
  directlyOpenUrl?: boolean;
  /** Run browser without visible window. Default: true */
  headless?: boolean;
  /** Browser viewport size. Default: 1280x720 */
  viewport?: { width: number; height: number };
  /** Initial URL to navigate to before starting the task */
  startUrl?: string;
  /** Milliseconds to wait after each action for the page to settle. Default: 1500 */
  waitAfterAction?: number;
  /** Max consecutive identical actions before the agent auto-fails. Default: 3 */
  maxRepeats?: number;
  /**
   * Include a simplified DOM/accessibility tree (each interactive element
   * tagged with its exact center coordinates) alongside the screenshot.
   * Dramatically improves click accuracy — strongly recommended.
   * Default: true
   */
  useDOM?: boolean;
  /**
   * Allow the `evaluate` action to run arbitrary JavaScript inside the
   * page. Default: false (security). Only enable if you trust the source
   * of task strings — a malicious task could exfiltrate page contents.
   */
  allowEvaluate?: boolean;
  /**
   * Restrict navigation to specific domains. Wildcard patterns supported:
   * `"example.com"`, `"*.example.com"`, `"http*://example.com"`.
   * When set, any `navigate` action to a non-matching URL throws.
   */
  allowedDomains?: string[];
  /**
   * Block navigation to specific domains. Same pattern format as
   * `allowedDomains`. Evaluated AFTER `allowedDomains`, so if both are
   * set a URL must be in `allowedDomains` AND not in `prohibitedDomains`.
   */
  prohibitedDomains?: string[];
  /**
   * Path to a Playwright storageState JSON file.
   * Restores cookies, localStorage, and sessionStorage from a previous session.
   */
  storageState?: string;
  /**
   * Connect to an existing browser via Chrome DevTools Protocol instead
   * of launching one. Format: `"http://localhost:9222"`. When set,
   * `headless`, `stealth.args`, `recordVideo`, etc. are ignored — the
   * existing browser's configuration is used.
   */
  cdpUrl?: string;
  /**
   * Enable video recording of the browser session.
   * Pass `true` for default dir (`./browser-videos`) or `{ dir: "/path" }`.
   */
  recordVideo?: boolean | { dir: string };
  /**
   * Secure credential vault. The LLM never sees real values — only
   * placeholders like `{{email}}`, `{{password}}`. Real values are
   * injected at execution time and scrubbed from all logs.
   */
  credentials?: CredentialVault;
  /**
   * Enable stealth mode to avoid bot detection.
   * Pass `true` for sensible defaults or a `StealthConfig` object for fine control.
   * Patches navigator.webdriver, plugins, permissions, WebGL, and more.
   */
  stealth?: boolean | StealthConfig;
  /**
   * Simulate human-like behavior — jittered clicks, variable typing speed,
   * mouse movement curves, random micro-pauses.
   * Pass `true` for defaults or a `HumanizeConfig` for fine control.
   */
  humanize?: boolean | HumanizeConfig;
  /**
   * Unified memory config — persist browser sessions, decisions, and
   * summaries of past runs. Same config as Agent and VoiceAgent.
   */
  memory?: UnifiedMemoryConfig;
  /** Skills — pre-packaged or learned tool bundles. */
  skills?: Array<import("@agentium/core").Skill | string>;
  /**
   * Custom tools that the BrowserAgent itself can invoke during a run.
   * The agent emits `{ "action": "tool", "name": "<tool>", "args": {...} }`
   * and we dispatch to the tool's `execute(args)`. Use this for 2FA codes,
   * API calls, file I/O, calling out to other agents — anything the
   * browser can't do alone.
   */
  tools?: ToolDef[];
  /** Cost tracker — track vision model token usage and enforce budgets across browser runs. */
  costTracker?: CostTracker;
  logLevel?: LogLevel;
  eventBus?: EventBus;
}

// ── Run options ──────────────────────────────────────────────────────────

export interface BrowserRunOpts {
  /** Override startUrl from config */
  startUrl?: string;
  /** Per-run model API key override */
  apiKey?: string;
  /** Session identifier for memory persistence and event tracking */
  sessionId?: string;
  /** User identifier for memory personalization */
  userId?: string;
  /** Path to save storageState (cookies/auth) after the run completes */
  saveStorageState?: string;
  /** Per-run override of `maxSteps`. */
  maxSteps?: number;
}

// ── Output ───────────────────────────────────────────────────────────────

export interface BrowserRunOutput {
  /** Final text result produced by the agent */
  result: string;
  /** Whether the task completed successfully (vs maxSteps exhausted or fail) */
  success: boolean;
  /** Full action history with screenshots */
  steps: BrowserStep[];
  /** URL at completion */
  finalUrl: string;
  /** Last screenshot captured */
  finalScreenshot: Buffer;
  /** Total time taken in milliseconds */
  durationMs: number;
  /** Video file path (if recordVideo was enabled) */
  videoPath?: string;
  /** Extracted content from every `extract` action, in chronological order. */
  extractedContent?: string[];
}

export interface BrowserStep {
  index: number;
  action: BrowserAction;
  /** Screenshot taken before this action was executed. May be empty if useVision=false. */
  screenshot: Buffer;
  pageUrl: string;
  pageTitle: string;
  timestamp: Date;
  /** Simplified DOM snapshot (if useDOM is enabled) */
  dom?: string;
  /** Free-form result string produced by the action (e.g. extract output). */
  output?: string;
  /** Whether this step succeeded (vs threw / failed locator). Default: true. */
  ok?: boolean;
  /** Model's chain-of-thought reasoning (if `useThinking` was on). */
  thinking?: string;
  /** Model's evaluation of whether the previous action met its goal. */
  evaluationPreviousGoal?: string;
  /** Model's running memory of important state. */
  memory?: string;
  /** Model's stated next goal for this step. */
  nextGoal?: string;
}

/**
 * Structured envelope the model returns when `useThinking: true`. Inspired
 * by browser-use's `AgentOutput`. Every field is optional from a runtime
 * standpoint — only `action` is required for execution.
 */
export interface AgentOutput {
  thinking?: string;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  action: BrowserAction | BrowserAction[];
}

// ── Stealth & Humanize ──────────────────────────────────────────────────

export interface StealthConfig {
  /**
   * Remove `navigator.webdriver` flag and patch common detection vectors
   * (plugins, languages, permissions, WebGL, etc.). Default when stealth=true.
   */
  patchFingerprint?: boolean;
  /** Custom User-Agent string. A realistic one is used by default. */
  userAgent?: string;
  /** Browser locale. Default: "en-US" */
  locale?: string;
  /** Timezone ID (IANA). Default: "America/New_York" */
  timezone?: string;
  /** Fake geolocation */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** Ignore HTTPS certificate errors. Default: false (secure). Only enable for local testing. */
  ignoreHTTPSErrors?: boolean;
  /**
   * `window.devicePixelRatio` to emulate. Default: `1`. Set to `2` to mimic
   * a Retina display (sharper screenshots at 2× cost). Setting to 2 on a
   * non-Retina host display can cause the headed window to look zoomed-out
   * or stretched because the OS compositor downsamples a 2× surface.
   */
  deviceScaleFactor?: number;
  /** HTTP/SOCKS proxy. Format: "http://user:pass@host:port" */
  proxy?: { server: string; username?: string; password?: string };
}

export interface HumanizeConfig {
  /** Per-character typing delay range in ms. Default: [40, 120] */
  typingDelay?: [number, number];
  /** Random pixel offset added to click coordinates. Default: 3 */
  clickJitter?: number;
  /** Extra random pause between actions in ms range. Default: [200, 800] */
  actionDelay?: [number, number];
  /** Simulate human-like mouse movement to target before clicking. Default: true */
  mouseMovement?: boolean;
}

// ── Internal types ───────────────────────────────────────────────────────

export interface PageInfo {
  url: string;
  title: string;
  viewportSize: { width: number; height: number };
}
