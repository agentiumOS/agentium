import { buildStealthContextOpts, buildStealthLaunchArgs, getStealthScript, pickUserAgent } from "./stealth.js";
import type { HumanizeConfig, PageInfo, StealthConfig } from "./types.js";

/**
 * Playwright wrapper with stealth anti-detection and human-like behavior.
 */
export class BrowserProvider {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private pages: Map<string, any> = new Map();
  private activeTabId = "tab-0";
  private tabCounter = 0;
  private _viewport: { width: number; height: number };
  private _videoDir?: string;
  private _humanize?: Required<HumanizeConfig>;

  constructor() {
    this._viewport = { width: 1280, height: 720 };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async launch(opts?: {
    headless?: boolean;
    viewport?: { width: number; height: number };
    storageState?: string;
    recordVideo?: boolean | { dir: string };
    stealth?: boolean | StealthConfig;
    humanize?: boolean | HumanizeConfig;
  }): Promise<void> {
    const pw = await import("playwright");
    const chromium = pw.chromium;

    this._viewport = opts?.viewport ?? { width: 1280, height: 720 };

    const stealthEnabled = !!opts?.stealth;
    const stealthCfg: StealthConfig = typeof opts?.stealth === "object" ? opts.stealth : {};

    // ── Humanize defaults ──────────────────────────────────────────
    if (opts?.humanize) {
      const h = typeof opts.humanize === "object" ? opts.humanize : {};
      this._humanize = {
        typingDelay: h.typingDelay ?? [40, 120],
        clickJitter: h.clickJitter ?? 3,
        actionDelay: h.actionDelay ?? [200, 800],
        mouseMovement: h.mouseMovement ?? true,
      };
    }

    // ── Launch options ─────────────────────────────────────────────
    const launchOpts: Record<string, unknown> = {
      headless: opts?.headless ?? true,
    };

    if (stealthEnabled) {
      const { args, proxy } = buildStealthLaunchArgs(stealthCfg);
      launchOpts.args = args;
      if (proxy) launchOpts.proxy = proxy;
    }

    this.browser = await chromium.launch(launchOpts);

    // ── Context options ────────────────────────────────────────────
    let contextOpts: Record<string, unknown>;

    if (stealthEnabled) {
      contextOpts = buildStealthContextOpts(stealthCfg, this._viewport);
    } else {
      contextOpts = {
        viewport: this._viewport,
        userAgent: pickUserAgent(),
      };
    }

    if (opts?.storageState) {
      contextOpts.storageState = opts.storageState;
    }

    if (opts?.recordVideo) {
      const dir = typeof opts.recordVideo === "object" ? opts.recordVideo.dir : "./browser-videos";
      contextOpts.recordVideo = { dir, size: this._viewport };
      this._videoDir = dir;
    }

    this.context = await this.browser.newContext(contextOpts);

    // ── Inject stealth scripts into every page ────────────────────
    if (stealthEnabled && stealthCfg.patchFingerprint !== false) {
      await this.context.addInitScript(getStealthScript());
    }

    this.page = await this.context.newPage();
    this.tabCounter = 0;
    this.activeTabId = "tab-0";
    this.pages.set("tab-0", this.page);
  }

  // ── Cookie / Auth Persistence ────────────────────────────────────────

  async saveStorageState(path: string): Promise<void> {
    this.ensureContext();
    await this.context.storageState({ path });
  }

  // ── Navigation ───────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    this.ensurePage();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid URL scheme: only http:// and https:// are allowed`);
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.waitForStable(500);
  }

  async back(): Promise<void> {
    this.ensurePage();
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  // ── Screenshot ───────────────────────────────────────────────────────

  async screenshot(): Promise<Buffer> {
    this.ensurePage();
    return await this.page.screenshot({ type: "png", fullPage: false });
  }

  // ── Interaction (with optional humanize) ─────────────────────────────

  async click(x: number, y: number): Promise<void> {
    this.ensurePage();

    const [fx, fy] = this.jitter(x, y);

    if (this._humanize?.mouseMovement) {
      await this.humanMouseMove(fx, fy);
    }

    await this.page.mouse.click(fx, fy);
    await this.humanPause();
  }

  async type(text: string): Promise<void> {
    this.ensurePage();
    const delay = this._humanize ? this.randInt(this._humanize.typingDelay[0], this._humanize.typingDelay[1]) : 30;
    await this.page.keyboard.type(text, { delay });
    await this.humanPause();
  }

  async clickAndType(x: number, y: number, text: string): Promise<void> {
    await this.click(x, y);
    await this.sleep(this._humanize ? this.randInt(150, 350) : 200);
    const [fx, fy] = this.jitter(x, y);
    await this.page.mouse.click(fx, fy, { clickCount: 3 });
    await this.sleep(this._humanize ? this.randInt(80, 200) : 100);
    await this.type(text);
  }

  async pressKey(key: string): Promise<void> {
    this.ensurePage();
    await this.page.keyboard.press(key);
  }

  async scroll(direction: "up" | "down", amount?: number): Promise<void> {
    this.ensurePage();
    const base = amount ?? 400;
    const jittered = this._humanize ? base + this.randInt(-40, 40) : base;
    const scrollY = direction === "down" ? jittered : -jittered;

    if (this._humanize) {
      const steps = this.randInt(2, 4);
      const perStep = scrollY / steps;
      for (let i = 0; i < steps; i++) {
        await this.page.mouse.wheel(0, perStep);
        await this.sleep(this.randInt(30, 80));
      }
    } else {
      await this.page.mouse.wheel(0, scrollY);
    }

    await this.humanPause();
  }

  // ── DOM Extraction ───────────────────────────────────────────────────

  async extractDOM(opts?: { maxElements?: number }): Promise<string> {
    this.ensurePage();
    const max = opts?.maxElements ?? 80;

    const elements: string = await this.page.evaluate((limit: number): string => {
      const selectors = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[role='tab']",
        "[role='menuitem']",
        "[onclick]",
        "[contenteditable='true']",
      ];
      const all = (globalThis as any).document.querySelectorAll(selectors.join(","));
      const lines: string[] = [];
      let count = 0;
      const vh = (globalThis as any).window.innerHeight;
      const vw = (globalThis as any).window.innerWidth;

      for (const el of all) {
        if (count >= limit) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (rect.right < 0 || rect.left > vw) continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || tag;
        const type = el.getAttribute("type") || "";
        const text = (el.textContent || "").trim().slice(0, 80);
        const placeholder = el.getAttribute("placeholder") || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const href = el.getAttribute("href") || "";
        const value = el.value || "";

        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);

        let label = ariaLabel || text || placeholder || value;
        if (!label && href) label = href.slice(0, 60);
        if (!label) label = `(${tag}${type ? ` type=${type}` : ""})`;

        lines.push(`[${cx},${cy}] ${role}${type ? `(${type})` : ""}: "${label}"`);
        count++;
      }
      return lines.join("\n");
    }, max);

    return elements;
  }

  // ── Page Info ────────────────────────────────────────────────────────

  async getPageInfo(): Promise<PageInfo> {
    this.ensurePage();
    const url: string = this.page.url();
    let title = "";
    try {
      title = await this.page.title();
    } catch (err) {
      console.warn("[agentium/browser] Error getting page title:", err instanceof Error ? err.message : err);
    }
    return { url, title, viewportSize: this._viewport };
  }

  async waitForStable(minWait = 300): Promise<void> {
    this.ensurePage();
    await this.sleep(minWait);
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch (err) {
      console.warn("[agentium/browser] Error waiting for stable:", err instanceof Error ? err.message : err);
    }
  }

  // ── Multi-Tab / Parallel Browsing ────────────────────────────────────

  async newTab(url?: string): Promise<string> {
    this.ensureContext();
    const newPage = await this.context.newPage();
    this.tabCounter++;
    const tabId = `tab-${this.tabCounter}`;
    this.pages.set(tabId, newPage);

    if (url) {
      await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return tabId;
  }

  async switchTab(tabId: string): Promise<void> {
    const targetPage = this.pages.get(tabId);
    if (!targetPage) throw new Error(`Tab "${tabId}" not found`);
    this.page = targetPage;
    this.activeTabId = tabId;
    await this.page.bringToFront();
  }

  async closeTab(tabId: string): Promise<void> {
    if (this.pages.size <= 1) throw new Error("Cannot close the last tab");
    const targetPage = this.pages.get(tabId);
    if (!targetPage) throw new Error(`Tab "${tabId}" not found`);

    await targetPage.close();
    this.pages.delete(tabId);

    if (this.activeTabId === tabId) {
      const firstRemaining = this.pages.entries().next().value;
      if (firstRemaining) {
        this.activeTabId = firstRemaining[0];
        this.page = firstRemaining[1];
      }
    }
  }

  listTabs(): { id: string; url: string; active: boolean }[] {
    const tabs: { id: string; url: string; active: boolean }[] = [];
    for (const [id, pg] of this.pages) {
      tabs.push({ id, url: pg.url(), active: id === this.activeTabId });
    }
    return tabs;
  }

  get currentTabId(): string {
    return this.activeTabId;
  }

  // ── Video Recording ──────────────────────────────────────────────────

  async getVideoPath(tabId?: string): Promise<string | null> {
    const targetPage = tabId ? this.pages.get(tabId) : this.page;
    if (!targetPage) return null;
    try {
      const video = targetPage.video();
      if (!video) return null;
      return await video.path();
    } catch (err) {
      console.warn("[agentium/browser] Error getting video path:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  get videoDir(): string | undefined {
    return this._videoDir;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  async close(): Promise<void> {
    try {
      if (this.context) await this.context.close();
    } catch (err) {
      console.warn("[agentium/browser] Error closing context:", err instanceof Error ? err.message : err);
    }
    try {
      if (this.browser) await this.browser.close();
    } catch (err) {
      console.warn("[agentium/browser] Error closing browser:", err instanceof Error ? err.message : err);
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.pages.clear();
  }

  // ── Private: Humanize helpers ────────────────────────────────────────

  /** Add small random offset to coordinates to avoid pixel-perfect bot patterns. */
  private jitter(x: number, y: number): [number, number] {
    if (!this._humanize) return [x, y];
    const j = this._humanize.clickJitter;
    return [x + this.randInt(-j, j), y + this.randInt(-j, j)];
  }

  /**
   * Simulate human mouse movement using Bézier-like interpolation.
   * Moves from the current mouse position to the target in small steps.
   */
  private async humanMouseMove(targetX: number, targetY: number): Promise<void> {
    const steps = this.randInt(5, 12);
    const startX = this._viewport.width / 2;
    const startY = this._viewport.height / 2;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t); // smoothstep
      const cx = startX + (targetX - startX) * ease + this.randInt(-2, 2);
      const cy = startY + (targetY - startY) * ease + this.randInt(-2, 2);
      await this.page.mouse.move(cx, cy);
      await this.sleep(this.randInt(5, 20));
    }

    await this.page.mouse.move(targetX, targetY);
  }

  /** Small random pause after an interaction. */
  private async humanPause(): Promise<void> {
    if (!this._humanize) return;
    const [min, max] = this._humanize.actionDelay;
    await this.sleep(this.randInt(min, max));
  }

  private randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private ensurePage(): void {
    if (!this.page) throw new Error("Browser not launched. Call launch() first.");
  }

  private ensureContext(): void {
    if (!this.context) throw new Error("Browser not launched. Call launch() first.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
