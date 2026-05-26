import type { CostTracker, EventBus, LogLevel, ModelProvider, UnifiedMemoryConfig } from "@agentium/core";
import type { CredentialVault } from "./credential-vault.js";

// ── Browser Actions ──────────────────────────────────────────────────────

export type BrowserAction =
  | { action: "click"; x: number; y: number; description: string }
  | { action: "type"; text: string; x?: number; y?: number }
  | { action: "scroll"; direction: "up" | "down"; amount?: number }
  | { action: "navigate"; url: string }
  | { action: "back" }
  | { action: "wait"; ms: number }
  | { action: "screenshot" }
  | { action: "done"; result: string }
  | { action: "fail"; reason: string };

// ── Config ───────────────────────────────────────────────────────────────

export interface BrowserAgentConfig {
  name: string;
  /** Vision-capable model (GPT-4o, Gemini, etc.) */
  model: ModelProvider;
  /** Extra instructions appended to the system prompt */
  instructions?: string;
  /** Max vision loop iterations. Default: 30 */
  maxSteps?: number;
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
   * Path to a Playwright storageState JSON file.
   * Restores cookies, localStorage, and sessionStorage from a previous session.
   */
  storageState?: string;
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
}

export interface BrowserStep {
  index: number;
  action: BrowserAction;
  /** Screenshot taken before this action was executed */
  screenshot: Buffer;
  pageUrl: string;
  pageTitle: string;
  timestamp: Date;
  /** Simplified DOM snapshot (if useDOM is enabled) */
  dom?: string;
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
