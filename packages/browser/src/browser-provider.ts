import { buildStealthContextOpts, buildStealthLaunchArgs, getStealthScript, pickUserAgent } from "./stealth.js";
import type { DomElement, HumanizeConfig, PageInfo, StealthConfig } from "./types.js";

/**
 * Playwright wrapper with stealth anti-detection, human-like behavior,
 * indexed DOM element resolution, and a rich action vocabulary.
 *
 * The `BrowserProvider` is intentionally LLM-agnostic — it exposes the
 * primitives that `BrowserAgent` orchestrates via vision+DOM reasoning.
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
  /**
   * Most recent DOM snapshot (one per `extractDOM` call). Indexed actions
   * (`clickByIndex`, `inputByIndex`, …) resolve their `index` against this.
   */
  private _lastDom: DomElement[] = [];
  /** True if we connected over CDP (don't tear down the browser on close). */
  private _attached = false;

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
    cdpUrl?: string;
  }): Promise<void> {
    const pw = await import("playwright");
    const chromium = pw.chromium;

    this._viewport = opts?.viewport ?? { width: 1280, height: 720 };

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

    // ── CDP attach mode ────────────────────────────────────────────
    if (opts?.cdpUrl) {
      this.browser = await chromium.connectOverCDP(opts.cdpUrl);
      this._attached = true;
      // Reuse the first existing context if any, else create one.
      const contexts = this.browser.contexts();
      this.context =
        contexts.length > 0 ? contexts[0] : await this.browser.newContext({ viewport: this._viewport });
      const existingPages = this.context.pages();
      this.page = existingPages.length > 0 ? existingPages[0] : await this.context.newPage();
      this.tabCounter = 0;
      this.activeTabId = "tab-0";
      this.pages.set("tab-0", this.page);
      return;
    }

    const stealthEnabled = !!opts?.stealth;
    const stealthCfg: StealthConfig = typeof opts?.stealth === "object" ? opts.stealth : {};

    // ── Launch options ─────────────────────────────────────────────
    // NOTE: we intentionally do NOT pass `--window-size` here. Playwright's
    // `viewport` (set on the context below) is the single source of truth
    // for the rendering surface dimensions. See v2.0.7 commit for the
    // full rationale.
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
    // `scale: "css"` forces the screenshot to viewport (CSS pixel) dimensions
    // regardless of the context's `deviceScaleFactor`. Keeps the image the
    // vision model sees aligned 1:1 with the coordinate space used for
    // mouse clicks.
    return await this.page.screenshot({
      type: "png",
      fullPage: false,
      scale: "css",
    });
  }

  /** Viewport size in CSS pixels (matches screenshot dimensions). */
  get viewport(): { width: number; height: number } {
    return this._viewport;
  }

  /** Most recent DOM snapshot. Each entry has a stable `index`. */
  get lastDom(): DomElement[] {
    return this._lastDom;
  }

  // ── Coordinate-based Interaction ─────────────────────────────────────

  async click(x: number, y: number): Promise<void> {
    this.ensurePage();

    const [cx, cy] = this.clampToViewport(x, y);
    const [fx, fy] = this.jitter(cx, cy);

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
    const [cx, cy] = this.clampToViewport(x, y);
    await this.click(cx, cy);
    await this.sleep(this._humanize ? this.randInt(150, 350) : 200);
    const [fx, fy] = this.jitter(cx, cy);
    await this.page.mouse.click(fx, fy, { clickCount: 3 });
    await this.sleep(this._humanize ? this.randInt(80, 200) : 100);
    await this.type(text);
  }

  async pressKey(key: string): Promise<void> {
    this.ensurePage();
    await this.page.keyboard.press(key);
  }

  /**
   * Send arbitrary keyboard keys / shortcuts. Accepts a single
   * Playwright key spec (`"Enter"`, `"Control+l"`, `"Shift+ArrowDown"`)
   * or a space-separated sequence (`"Tab Tab Enter"`).
   */
  async sendKeys(keys: string): Promise<void> {
    this.ensurePage();
    const tokens = keys.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      await this.page.keyboard.press(token);
      await this.sleep(this._humanize ? this.randInt(40, 120) : 30);
    }
    await this.humanPause();
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

  // ── Indexed Interaction (preferred path) ─────────────────────────────

  /**
   * Build a Playwright locator for a DOM-snapshot index. Each `extractDOM`
   * call tags surviving elements with `data-bua-idx="<n>"`; we resolve by
   * that attribute. Returns null if the index is unknown.
   */
  private locatorForIndex(index: number): any | null {
    if (!this.page) return null;
    if (!this._lastDom.find((e) => e.index === index)) return null;
    return this.page.locator(`[data-bua-idx="${index}"]`).first();
  }

  /**
   * Click an element by its DOM-snapshot index. The most reliable click
   * path on dynamic pages — survives layout shifts and DPR oddities.
   */
  async clickByIndex(index: number, opts?: { timeout?: number }): Promise<boolean> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return false;
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await loc.click({ timeout: opts?.timeout ?? 5000 });
      await this.humanPause();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Focus an indexed input, optionally clear it, and type. Returns false
   * if the index couldn't be resolved or the input couldn't be focused.
   */
  async inputByIndex(
    index: number,
    text: string,
    opts?: { clear?: boolean; submit?: boolean; timeout?: number },
  ): Promise<boolean> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return false;
    try {
      const timeout = opts?.timeout ?? 5000;
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      if (opts?.clear !== false) {
        await loc.fill("", { timeout });
      }
      // Use a humanised per-character type rather than `fill` so input
      // event listeners that depend on keystroke timing (autocomplete,
      // validation) still trigger.
      const delay = this._humanize ? this.randInt(this._humanize.typingDelay[0], this._humanize.typingDelay[1]) : 30;
      await loc.click({ timeout });
      await loc.pressSequentially(text, { delay });
      if (opts?.submit) {
        await this.page.keyboard.press("Enter");
      }
      await this.humanPause();
      return true;
    } catch {
      return false;
    }
  }

  async uploadFileByIndex(index: number, path: string): Promise<boolean> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return false;
    try {
      await loc.setInputFiles(path, { timeout: 5000 });
      await this.humanPause();
      return true;
    } catch {
      return false;
    }
  }

  /** Scroll the indexed element into view (no click). */
  async scrollIntoViewByIndex(index: number): Promise<boolean> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return false;
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Text-based Interaction ───────────────────────────────────────────

  /**
   * Deterministic, DOM-based click using Playwright's text locator.
   *
   * Returns `true` if a matching, visible, clickable element was found and
   * clicked within `timeout` ms; `false` otherwise (so the caller can fall
   * back to coordinate clicking). Substring-matches by default — e.g.
   * `clickByText("Cheapest")` matches "Cheapest · 23-28 days · $2,550".
   */
  async clickByText(keyword: string, opts?: { timeout?: number }): Promise<boolean> {
    this.ensurePage();
    const timeout = opts?.timeout ?? 3000;
    try {
      const locator = this.page.locator(`text=${keyword}`).first();
      await locator.click({ timeout });
      await this.humanPause();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scroll the first occurrence of `text` into view. Returns false if no
   * match was found within the timeout.
   */
  async findText(text: string, opts?: { timeout?: number }): Promise<boolean> {
    this.ensurePage();
    const timeout = opts?.timeout ?? 3000;
    try {
      const locator = this.page.getByText(text).first();
      await locator.scrollIntoViewIfNeeded({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  // ── Dropdowns ────────────────────────────────────────────────────────

  /**
   * Read the options of a native `<select>` at the given DOM-snapshot
   * index. Returns `[]` if the element is not a `<select>`.
   */
  async dropdownOptions(index: number): Promise<{ value: string; label: string; selected: boolean }[]> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return [];
    try {
      return (await loc.evaluate((el: any) => {
        if (!el || el.tagName !== "SELECT") return [];
        return Array.from(el.options).map((opt: any) => ({
          value: opt.value,
          label: (opt.label || opt.textContent || "").trim(),
          selected: !!opt.selected,
        }));
      })) as { value: string; label: string; selected: boolean }[];
    } catch {
      return [];
    }
  }

  /**
   * Select an option in a native `<select>` by its visible text or value.
   * Returns false if the element isn't a `<select>` or no option matched.
   */
  async selectDropdown(index: number, text: string): Promise<boolean> {
    this.ensurePage();
    const loc = this.locatorForIndex(index);
    if (!loc) return false;
    try {
      await loc.selectOption({ label: text }, { timeout: 3000 });
      await this.humanPause();
      return true;
    } catch {
      try {
        await loc.selectOption({ value: text }, { timeout: 3000 });
        await this.humanPause();
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── JS Evaluation ────────────────────────────────────────────────────

  /**
   * Run arbitrary JS in the page context. The caller is responsible for
   * gating this behind a config flag — the BrowserAgent only routes the
   * `evaluate` action here when `allowEvaluate: true`.
   *
   * The code is wrapped in `(async () => { ... })()` and the return value
   * is coerced to a string for the model.
   */
  async evaluate(code: string): Promise<string> {
    this.ensurePage();
    try {
      const result = await this.page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function("return (async () => { " + code + " })()") as any,
      );
      if (result === undefined) return "undefined";
      if (result === null) return "null";
      if (typeof result === "string") return result;
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    } catch (e: any) {
      throw new Error(`evaluate failed: ${e?.message ?? e}`);
    }
  }

  // ── Page text (for `extract`) ────────────────────────────────────────

  /**
   * Returns a clean text representation of the visible page body, with
   * optional link extraction. Used by the BrowserAgent's `extract` action
   * — the text is passed to a (usually cheap) LLM with the user's query.
   */
  async pageText(opts?: { extractLinks?: boolean; maxChars?: number }): Promise<string> {
    this.ensurePage();
    const maxChars = opts?.maxChars ?? 20_000;
    const extractLinks = !!opts?.extractLinks;
    const raw: string = await this.page.evaluate((withLinks: boolean) => {
      const doc = (globalThis as any).document;
      // Walk the body, skipping invisible nodes, scripts, styles.
      const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);
      const win = (globalThis as any).window;
      const lines: string[] = [];

      function visit(node: any) {
        if (!node) return;
        if (node.nodeType === 3) {
          const t = (node.nodeValue || "").trim();
          if (t) lines.push(t);
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = (node.tagName as string).toUpperCase();
        if (SKIP.has(tag)) return;
        const style = win.getComputedStyle(node);
        if (style && (style.visibility === "hidden" || style.display === "none")) return;
        if (tag === "A" && withLinks) {
          const href = node.getAttribute("href") || "";
          const txt = (node.innerText || node.textContent || "").trim();
          if (txt && href) {
            lines.push(`[${txt}](${href})`);
            return;
          }
        }
        for (const child of node.childNodes) visit(child);
      }
      visit(doc.body);
      return lines.join("\n");
    }, extractLinks);
    const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
    return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}\n…[truncated]` : collapsed;
  }

  // ── DOM Extraction (with index tagging) ──────────────────────────────

  /**
   * Snapshot the interactive elements visible in the viewport, tag each
   * with a `data-bua-idx="<n>"` attribute (used by indexed actions), and
   * return BOTH a human-readable string (for the model) and the
   * structured list (for the runtime).
   *
   * Three properties matter for accuracy:
   *  - Hit-tested: each listed coordinate / index actually reaches the
   *    labeled element (overlays / occlusion skip the entry).
   *  - Visibility-filtered: invisible, zero-size, `pointer-events: none`,
   *    and near-zero-opacity elements are excluded.
   *  - `cursor: pointer` fallback pass: a second scan catches custom React
   *    widgets that have no semantic role/href/onclick but are clickable.
   */
  async extractDOM(opts?: { maxElements?: number }): Promise<{ text: string; elements: DomElement[] }> {
    this.ensurePage();
    const max = opts?.maxElements ?? 120;

    const raw: DomElement[] = await this.page.evaluate((limit: number): DomElement[] => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;

      // Clear any markers left over from previous snapshots.
      for (const stale of doc.querySelectorAll("[data-bua-idx]")) {
        stale.removeAttribute("data-bua-idx");
      }

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
        "[role='checkbox']",
        "[role='radio']",
        "[role='switch']",
        "[role='combobox']",
        "[role='option']",
        "[onclick]",
        "[contenteditable='true']",
        "[tabindex]:not([tabindex='-1'])",
      ];
      const semantic = Array.from(doc.querySelectorAll(selectors.join(","))) as any[];

      // Second pass: anything whose computed cursor is `pointer`.
      const POINTER_SCAN_CAP = 2000;
      const pointerCandidates: any[] = [];
      const allEls = doc.querySelectorAll("*") as ArrayLike<any>;
      for (let i = 0; i < allEls.length && pointerCandidates.length < POINTER_SCAN_CAP; i++) {
        const el = allEls[i];
        if (!el) continue;
        const tag = (el.tagName as string).toLowerCase();
        if (tag === "html" || tag === "body" || tag === "head" || tag === "script" || tag === "style") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        if (rect.bottom < 0 || rect.top > win.innerHeight) continue;
        if (rect.right < 0 || rect.left > win.innerWidth) continue;
        const style = win.getComputedStyle(el);
        if (style.cursor !== "pointer") continue;
        pointerCandidates.push(el);
      }

      const all = semantic.concat(pointerCandidates);
      const vh = win.innerHeight as number;
      const vw = win.innerWidth as number;

      const entries: Array<{ el: any; cx: number; cy: number }> = [];
      const seen = new Set<any>();

      for (const el of all) {
        if (seen.has(el)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        if (rect.bottom < 0 || rect.top > vh) continue;
        if (rect.right < 0 || rect.left > vw) continue;

        const style = win.getComputedStyle(el);
        if (
          style.visibility === "hidden" ||
          style.display === "none" ||
          style.pointerEvents === "none" ||
          parseFloat(style.opacity || "1") < 0.1
        ) {
          continue;
        }

        const cx = Math.round(Math.max(0, Math.min(vw - 1, rect.left + rect.width / 2)));
        const cy = Math.round(Math.max(0, Math.min(vh - 1, rect.top + rect.height / 2)));

        try {
          const hit = doc.elementFromPoint(cx, cy);
          if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
            continue;
          }
          if (hit && el.contains(hit)) seen.add(hit);
        } catch {
          // ignore hit-testing failures
        }

        seen.add(el);
        entries.push({ el, cx, cy });
      }

      // Sort top-to-bottom, left-to-right.
      entries.sort((a, b) => (a.cy === b.cy ? a.cx - b.cx : a.cy - b.cy));

      const out: DomElement[] = [];
      let idx = 1;
      for (const { el, cx, cy } of entries) {
        if (out.length >= limit) break;
        const tag = (el.tagName as string).toLowerCase();
        const role = el.getAttribute("role") || tag;
        const type = el.getAttribute("type") || "";
        const innerText = (el.innerText || el.textContent || "") as string;
        const text = innerText.trim().replace(/\s+/g, " ").slice(0, 80);
        const placeholder = el.getAttribute("placeholder") || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const title = el.getAttribute("title") || "";
        const name = el.getAttribute("name") || "";
        const href = el.getAttribute("href") || "";
        const value = (el.value || "") as string;

        let label = ariaLabel || text || placeholder || title || value || name;
        if (!label && href) label = href.slice(0, 60);
        if (!label) label = `(${tag}${type ? ` type=${type}` : ""})`;

        el.setAttribute("data-bua-idx", String(idx));

        out.push({
          index: idx,
          cx,
          cy,
          role,
          type: type || undefined,
          label,
          tag,
          isInput: tag === "input" || tag === "textarea" || el.isContentEditable === true,
          isSelect: tag === "select",
          isFile: tag === "input" && type === "file",
        });
        idx++;
      }

      return out;
    }, max);

    this._lastDom = raw;

    const lines = raw.map((e) => {
      const typeSuffix = e.type ? `(${e.type})` : "";
      return `[${e.index}] [${e.cx},${e.cy}] ${e.role}${typeSuffix}: "${e.label}"`;
    });

    return { text: lines.join("\n"), elements: raw };
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
      if (this.context && !this._attached) await this.context.close();
    } catch (err) {
      console.warn("[agentium/browser] Error closing context:", err instanceof Error ? err.message : err);
    }
    try {
      if (this.browser && !this._attached) await this.browser.close();
      else if (this.browser && this._attached) {
        // CDP-attached: don't kill the remote browser, just detach.
        try {
          await this.browser.close();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.warn("[agentium/browser] Error closing browser:", err instanceof Error ? err.message : err);
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    this.pages.clear();
    this._lastDom = [];
  }

  // ── Private: Humanize helpers ────────────────────────────────────────

  /** Add small random offset to coordinates to avoid pixel-perfect bot patterns. */
  private jitter(x: number, y: number): [number, number] {
    if (!this._humanize) return [x, y];
    const j = this._humanize.clickJitter;
    return [x + this.randInt(-j, j), y + this.randInt(-j, j)];
  }

  /**
   * Safety net: clamp coordinates returned by the vision model to the actual
   * viewport. If a model occasionally returns image-space coordinates from a
   * 2x screenshot (despite our `scale: "css"` fix), this prevents Playwright
   * from clicking at e.g. (2200, 1300) and either erroring or landing on a
   * random off-screen element.
   */
  private clampToViewport(x: number, y: number): [number, number] {
    const cx = Math.max(0, Math.min(this._viewport.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(this._viewport.height - 1, Math.round(y)));
    return [cx, cy];
  }

  /**
   * Simulate human mouse movement using smoothstep interpolation.
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
