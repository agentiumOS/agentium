import type { ChatMessage, CostTracker, ModelProvider, ToolDef } from "@agentium/core";
import { EventBus, Logger, MemoryManager, RunContext } from "@agentium/core";
import { z } from "zod";
import { BrowserProvider } from "./browser-provider.js";
import type { CredentialVault } from "./credential-vault.js";
import { fnvHash, type LoopAdvice, LoopDetector } from "./loop-detector.js";
import { buildSystemPrompt, buildUserMessage, summarizeAction } from "./prompts.js";
import type {
  AgentOutput,
  BrowserAction,
  BrowserAgentConfig,
  BrowserRunOpts,
  BrowserRunOutput,
  BrowserStep,
  DomScrollContext,
} from "./types.js";

export class BrowserAgent {
  readonly name: string;
  readonly eventBus: EventBus;

  private model: ModelProvider;
  private pageExtractionLLM: ModelProvider | null;
  private fallbackModel: ModelProvider | null;
  private useThinking: boolean;
  private historyWindow: number;
  private instructions?: string;
  private extendSystemMessage?: string;
  private overrideSystemMessage?: string;
  private maxSteps: number;
  private maxFailures: number;
  private maxActionsPerStep: number;
  private initialActions: BrowserAction[];
  private useVision: boolean | "auto";
  private directlyOpenUrl: boolean;
  private headless: boolean;
  private viewport: { width: number; height: number };
  private defaultStartUrl?: string;
  private waitAfterAction: number;
  private maxRepeats: number;
  private useDOM: boolean;
  private allowEvaluate: boolean;
  private allowedDomains?: string[];
  private prohibitedDomains?: string[];
  private storageState?: string;
  private cdpUrl?: string;
  private recordVideo?: boolean | { dir: string };
  private credentials?: CredentialVault;
  private stealth?: import("./types.js").StealthConfig | boolean;
  private humanize?: import("./types.js").HumanizeConfig | boolean;
  private tools: ToolDef[];
  private costTracker: CostTracker | null;
  private memoryManager: MemoryManager | null = null;
  private logger: Logger;

  /** Access the MemoryManager (if memory is configured). */
  get memory(): MemoryManager | null {
    return this.memoryManager;
  }

  constructor(config: BrowserAgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.pageExtractionLLM = config.pageExtractionLLM ?? null;
    this.fallbackModel = config.fallbackModel ?? null;
    this.useThinking = config.useThinking ?? true;
    this.historyWindow = Math.max(0, config.historyWindow ?? 6);
    this.instructions = config.instructions;
    this.extendSystemMessage = config.extendSystemMessage;
    this.overrideSystemMessage = config.overrideSystemMessage;
    this.maxSteps = config.maxSteps ?? 30;
    this.maxFailures = config.maxFailures ?? 3;
    this.maxActionsPerStep = Math.max(1, config.maxActionsPerStep ?? 3);
    this.initialActions = config.initialActions ?? [];
    this.useVision = config.useVision ?? "auto";
    this.directlyOpenUrl = config.directlyOpenUrl ?? true;
    this.headless = config.headless ?? true;
    this.viewport = config.viewport ?? { width: 1280, height: 720 };
    this.defaultStartUrl = config.startUrl;
    this.waitAfterAction = config.waitAfterAction ?? 1500;
    this.maxRepeats = config.maxRepeats ?? 3;
    this.useDOM = config.useDOM ?? true;
    this.allowEvaluate = config.allowEvaluate ?? false;
    this.allowedDomains = config.allowedDomains;
    this.prohibitedDomains = config.prohibitedDomains;
    this.storageState = config.storageState;
    this.cdpUrl = config.cdpUrl;
    this.recordVideo = config.recordVideo;
    this.credentials = config.credentials;
    this.stealth = config.stealth;
    this.humanize = config.humanize;
    this.tools = config.tools ?? [];
    this.costTracker = config.costTracker ?? null;
    this.eventBus = config.eventBus ?? new EventBus();
    this.logger = new Logger({
      prefix: `BrowserAgent:${config.name}`,
      level: config.logLevel ?? "silent",
    });

    if (config.memory) {
      this.memoryManager = new MemoryManager(config.memory);
    }
  }

  async run(task: string, opts?: BrowserRunOpts): Promise<BrowserRunOutput> {
    const startTime = Date.now();
    const maxSteps = opts?.maxSteps ?? this.maxSteps;
    const sessionId = opts?.sessionId ?? `browser_${Date.now()}`;
    const userId = opts?.userId;
    const browser = new BrowserProvider();
    const steps: BrowserStep[] = [];
    const actionHistory: string[] = [];
    const extractedContent: string[] = [];
    let lastExtractResult: string | undefined;
    let consecutiveFailures = 0;
    let lastActionWasScreenshot = false;

    const loop = new LoopDetector();
    /**
     * Rolling conversation history. Each entry stores the structured
     * agent envelope so we can replay model_thoughts to the model on
     * subsequent steps — this is what `historyWindow > 0` buys us.
     */
    const historyTurns: Array<{
      userText: string;
      hasScreenshot: boolean;
      envelope: AgentOutput;
    }> = [];

    // ── Compose instructions (memory + user-provided) ────────────────
    const baseExtra = [this.instructions, this.extendSystemMessage].filter(Boolean).join("\n\n");
    let extraInstructions = baseExtra;
    if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      const memoryContext = await this.memoryManager.buildContext(sessionId, userId, task, this.name);
      if (memoryContext) {
        extraInstructions = extraInstructions ? `${extraInstructions}\n\n${memoryContext}` : memoryContext;
      }
    }

    const credentialKeys = this.credentials?.keys();
    const systemPrompt = buildSystemPrompt(this.viewport, extraInstructions || undefined, credentialKeys, {
      overrideSystemMessage: this.overrideSystemMessage,
      maxActionsPerStep: this.maxActionsPerStep,
      allowEvaluate: this.allowEvaluate,
      tools: this.tools,
      useVision: this.useVision,
      useDOM: this.useDOM,
      useThinking: this.useThinking,
    });

    try {
      this.logger.info("Launching browser", {
        headless: this.headless,
        viewport: this.viewport,
        useDOM: this.useDOM,
        useVision: this.useVision,
        useThinking: this.useThinking,
        cdpUrl: this.cdpUrl ?? undefined,
        recordVideo: !!this.recordVideo,
        stealth: !!this.stealth,
        humanize: !!this.humanize,
      });

      await browser.launch({
        headless: this.headless,
        viewport: this.viewport,
        storageState: this.storageState,
        recordVideo: this.recordVideo,
        stealth: this.stealth,
        humanize: this.humanize,
        cdpUrl: this.cdpUrl,
      });

      // ── Decide the starting URL ────────────────────────────────
      const startUrl = opts?.startUrl ?? this.defaultStartUrl ?? this.detectUrlInTask(task);
      if (startUrl) {
        this.logger.info("Navigating to start URL", { url: startUrl });
        this.assertDomainAllowed(startUrl);
        await browser.navigate(startUrl);
        await this.navigationHealthCheck(browser, startUrl);
      }

      // ── Run initialActions (no LLM cost) ───────────────────────
      for (const ia of this.initialActions) {
        try {
          await this.executeAction(browser, ia, actionHistory, extractedContent);
        } catch (e: any) {
          this.logger.warn("initialAction failed", { action: ia, error: e?.message });
        }
        await this.sleep(this.waitAfterAction);
      }

      // ── Main loop ──────────────────────────────────────────────
      for (let step = 0; step < maxSteps; step++) {
        const pageInfo = await browser.getPageInfo();

        // ── Build DOM snapshot + scroll context ────────────────
        let domSnapshot: string | undefined;
        let scrollCtx: DomScrollContext | undefined;
        if (this.useDOM) {
          const dom = await browser.extractDOM();
          domSnapshot = dom.text;
          scrollCtx = dom.scroll;
        }

        // ── Page-stagnation detection ──────────────────────────
        const pageAdvice = loop.recordPage({
          url: pageInfo.url,
          interactiveCount: scrollCtx?.totalInteractive ?? 0,
          textHash: fnvHash(domSnapshot ?? ""),
        });
        if (pageAdvice.severity === "abort") {
          return await this.finalize(browser, steps, startTime, opts, extractedContent, {
            result: pageAdvice.message ?? "Auto-stopped: page is stagnant.",
            success: false,
          });
        }

        const wantVision = this.shouldCaptureVision(step, lastActionWasScreenshot);
        const screenshot = wantVision ? await browser.screenshot() : Buffer.alloc(0);
        if (wantVision) this.eventBus.emit("browser.screenshot", { data: screenshot });

        const isLastStep = step === maxSteps - 1;
        const nudgeParts: string[] = [];
        if (pageAdvice.severity !== "none" && pageAdvice.message) nudgeParts.push(pageAdvice.message);
        if (isLastStep) {
          nudgeParts.push(
            "This is your FINAL step. Return a `done` action right now summarizing whatever you have, even if partial.",
          );
        }
        const nudge = nudgeParts.length > 0 ? nudgeParts.join(" ") : undefined;

        const userText = buildUserMessage(
          task,
          pageInfo.url,
          pageInfo.title,
          step,
          actionHistory,
          domSnapshot,
          lastExtractResult,
          scrollCtx,
          nudge,
          { current: step, max: maxSteps },
        );

        const messages = this.buildMessages(systemPrompt, historyTurns, userText, wantVision ? screenshot : null);

        this.logger.debug("Calling model", { step, url: pageInfo.url, vision: wantVision });

        // ── Model call (with fallback on transient errors) ────
        const { response, modelUsed } = await this.callModelWithFallback(messages, opts?.apiKey);
        if (!response) {
          consecutiveFailures++;
          actionHistory.push(`(model call failed — retrying, ${consecutiveFailures}/${this.maxFailures})`);
          if (consecutiveFailures > this.maxFailures) {
            return await this.forceDone(browser, steps, startTime, opts, extractedContent, actionHistory, "model");
          }
          continue;
        }

        if (this.costTracker && response.usage) {
          this.costTracker.track({
            runId: sessionId,
            agentName: this.name,
            modelId: modelUsed.modelId,
            usage: response.usage,
            sessionId,
            userId,
          });
        }

        const raw = typeof response.message.content === "string" ? response.message.content : "";
        const envelope = this.parseEnvelope(raw);
        if (!envelope) {
          consecutiveFailures++;
          this.logger.warn("Failed to parse model response", { raw: raw.slice(0, 200), consecutiveFailures });
          if (consecutiveFailures > this.maxFailures) {
            return await this.forceDone(browser, steps, startTime, opts, extractedContent, actionHistory, "parse");
          }
          actionHistory.push("(invalid JSON response — retrying)");
          continue;
        }

        // The model produced a parseable envelope; reset the failure counter.
        consecutiveFailures = 0;

        // Push this turn into the rolling history (for next step's context).
        historyTurns.push({ userText, hasScreenshot: wantVision, envelope });
        // Trim to the configured window. Older turns are summarized inline
        // by `buildMessages` so they don't fall out of context entirely.
        if (this.historyWindow > 0 && historyTurns.length > this.historyWindow) {
          historyTurns.splice(0, historyTurns.length - this.historyWindow);
        }

        // Normalize action(s) to an array and cap to maxActionsPerStep.
        const actions: BrowserAction[] = (Array.isArray(envelope.action) ? envelope.action : [envelope.action]).slice(
          0,
          this.maxActionsPerStep,
        );

        let didTerminate: { result: string; success: boolean } | null = null;
        let didNavigate = false;
        lastActionWasScreenshot = false;

        for (let ai = 0; ai < actions.length; ai++) {
          const action = actions[ai];

          let summary = summarizeAction(action as unknown as Record<string, unknown>);
          if (this.credentials) summary = this.credentials.mask(summary);

          // ── Loop detection ────────────────────────────────────
          const advice: LoopAdvice = loop.recordAction(action);
          if (advice.severity === "abort" && action.action !== "done" && action.action !== "fail") {
            this.logger.warn("Loop detector aborting run", { advice });
            actionHistory.push(`⚠ ${advice.message ?? "loop detected — auto-stopping"}`);
            didTerminate = {
              result: advice.message ?? "Stuck in a loop — auto-stopped.",
              success: false,
            };
            break;
          }
          // Softer severities are surfaced via the `nudge` next step (see above).

          actionHistory.push(summary);
          this.logger.info(`Step ${step + 1}.${ai + 1}: ${summary}`);
          this.eventBus.emit("browser.action", { action });

          // Terminal actions.
          if (action.action === "done") {
            const result = this.credentials ? this.credentials.mask(action.result) : action.result;
            didTerminate = { result, success: true };
            break;
          }
          if (action.action === "fail") {
            const result = this.credentials ? this.credentials.mask(action.reason) : action.reason;
            didTerminate = { result, success: false };
            break;
          }

          // Execute and track.
          let stepOk = true;
          let stepOutput: string | undefined;
          try {
            const exec = await this.executeAction(browser, action, actionHistory, extractedContent);
            stepOutput = exec?.output;
            if (exec?.didNavigate) {
              didNavigate = true;
              await this.navigationHealthCheck(browser, pageInfo.url);
            }
            if (action.action === "extract" && exec?.output) lastExtractResult = exec.output;
            if (action.action === "screenshot") lastActionWasScreenshot = true;
          } catch (e: any) {
            stepOk = false;
            consecutiveFailures++;
            this.logger.warn("Action failed", { action: action.action, error: e?.message, consecutiveFailures });
            actionHistory.push(`(error: ${e?.message ?? "unknown"})`);
            if (consecutiveFailures > this.maxFailures) {
              didTerminate = {
                result: `Action ${action.action} failed ${consecutiveFailures} times. Last error: ${e?.message}`,
                success: false,
              };
              break;
            }
          }

          steps.push({
            index: steps.length,
            action,
            screenshot,
            pageUrl: pageInfo.url,
            pageTitle: pageInfo.title,
            timestamp: new Date(),
            dom: domSnapshot,
            output: stepOutput,
            ok: stepOk,
            thinking: envelope.thinking,
            evaluationPreviousGoal: envelope.evaluationPreviousGoal,
            memory: envelope.memory,
            nextGoal: envelope.nextGoal,
          });

          this.eventBus.emit("browser.step", {
            index: steps.length - 1,
            action,
            pageUrl: pageInfo.url,
            screenshot,
          });

          await this.sleep(this.waitAfterAction);
          if (didNavigate) break;
        }

        if (didTerminate) {
          return await this.finalize(browser, steps, startTime, opts, extractedContent, didTerminate);
        }
      }

      // Max steps exhausted — force a salvage `done` rather than just bailing.
      this.logger.warn("Max steps reached without explicit done", { maxSteps });
      return await this.forceDone(browser, steps, startTime, opts, extractedContent, actionHistory, "max_steps");
    } catch (error: any) {
      this.logger.error("Browser agent error", { error: error.message });
      this.eventBus.emit("browser.error", { error });
      await browser.close();

      return {
        result: `Error: ${error.message}`,
        success: false,
        steps,
        finalUrl: "",
        finalScreenshot: Buffer.alloc(0),
        durationMs: Date.now() - startTime,
        extractedContent,
      };
    }
  }

  /**
   * Returns a ToolDef that lets a regular Agent delegate browser tasks
   * to this BrowserAgent.
   */
  asTool(config?: { name?: string; description?: string }): ToolDef {
    return {
      name: config?.name ?? "browse_web",
      description:
        config?.description ??
        "Open a browser and autonomously complete a task on a website. Provide a clear task description and optionally a starting URL.",
      parameters: z.object({
        task: z.string().describe("What to do in the browser (e.g., 'Search for X and return the top 3 results')"),
        startUrl: z.string().optional().describe("URL to start at (e.g., 'https://www.google.com')"),
      }),
      execute: async (args: Record<string, unknown>) => {
        const result = await this.run(args.task as string, { startUrl: args.startUrl as string | undefined });
        return result.result;
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private shouldCaptureVision(step: number, lastActionWasScreenshot: boolean): boolean {
    if (this.useVision === false) return false;
    if (this.useVision === true) return true;
    // "auto":
    // - always include vision on the first step (model needs to orient itself)
    // - always include if useDOM is false (no other signal)
    // - otherwise only when the model explicitly requested it last step
    if (step === 0) return true;
    if (!this.useDOM) return true;
    return lastActionWasScreenshot;
  }

  private detectUrlInTask(task: string): string | undefined {
    if (!this.directlyOpenUrl) return undefined;
    const match = task.match(/https?:\/\/[^\s)<>"']+/);
    return match ? match[0] : undefined;
  }

  private assertDomainAllowed(url: string): void {
    if (!this.allowedDomains?.length && !this.prohibitedDomains?.length) return;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`Cannot parse URL for domain check: ${url}`);
    }
    if (this.allowedDomains?.length && !this.allowedDomains.some((p) => matchDomain(host, p))) {
      throw new Error(`Navigation blocked: ${host} is not in allowedDomains`);
    }
    if (this.prohibitedDomains?.length && this.prohibitedDomains.some((p) => matchDomain(host, p))) {
      throw new Error(`Navigation blocked: ${host} is in prohibitedDomains`);
    }
  }

  /**
   * Build the message array sent to the model: system prompt + a compact
   * summary of older turns (if any) + the most recent `historyWindow`
   * turns verbatim + the current step's user message.
   *
   * Inspired by browser-use's history compaction. Keeps tokens bounded
   * while giving the model meaningful context about what it already
   * tried.
   */
  private buildMessages(
    systemPrompt: string,
    historyTurns: Array<{ userText: string; hasScreenshot: boolean; envelope: AgentOutput }>,
    currentUserText: string,
    currentScreenshot: Buffer | null,
  ): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    // If historyWindow is disabled, skip the entire conversation block.
    if (this.historyWindow > 0 && historyTurns.length > 0) {
      // Older turns get a single compacted summary message.
      // (In v2.2 we keep this lightweight — just memory + a few thinking
      //  lines. Later versions can compact via the pageExtractionLLM.)
      for (const turn of historyTurns) {
        // Replay just the model's structured response. We deliberately
        // drop the user text here to keep token usage tight; the agent
        // already saw it once.
        const env = turn.envelope;
        const replay: string[] = [];
        if (env.thinking) replay.push(`thinking: ${env.thinking}`);
        if (env.evaluationPreviousGoal) replay.push(`evaluation: ${env.evaluationPreviousGoal}`);
        if (env.memory) replay.push(`memory: ${env.memory}`);
        if (env.nextGoal) replay.push(`next_goal: ${env.nextGoal}`);
        replay.push(`action: ${JSON.stringify(env.action)}`);
        msgs.push({ role: "assistant", content: replay.join("\n") });
      }
    }

    // Current step.
    const content: any[] = [];
    if (currentScreenshot && currentScreenshot.length > 0) {
      content.push({
        type: "image",
        data: currentScreenshot.toString("base64"),
        mimeType: "image/png",
      });
    }
    content.push({ type: "text", text: currentUserText });
    msgs.push({ role: "user", content });

    return msgs;
  }

  /**
   * Call the primary model, retrying once with `fallbackModel` on
   * transient errors (5xx, 429, network). Returns the response or
   * `null` if both models failed.
   */
  private async callModelWithFallback(
    messages: ChatMessage[],
    apiKey?: string,
  ): Promise<{ response: any | null; modelUsed: ModelProvider }> {
    const reqOpts = { temperature: 0.1, maxTokens: 1024, apiKey, responseFormat: "json" as const };
    try {
      const r = await this.model.generate(messages, reqOpts);
      return { response: r, modelUsed: this.model };
    } catch (e: any) {
      if (this.fallbackModel && this.isTransientError(e)) {
        this.logger.warn("Primary model failed; trying fallbackModel", {
          error: e?.message,
          primary: this.model.modelId,
          fallback: this.fallbackModel.modelId,
        });
        try {
          const r = await this.fallbackModel.generate(messages, reqOpts);
          return { response: r, modelUsed: this.fallbackModel };
        } catch (e2: any) {
          this.logger.warn("Fallback model also failed", { error: e2?.message });
          return { response: null, modelUsed: this.model };
        }
      }
      this.logger.warn("Model call failed (no fallback configured)", { error: e?.message });
      return { response: null, modelUsed: this.model };
    }
  }

  private isTransientError(e: any): boolean {
    const msg = String(e?.message ?? e).toLowerCase();
    if (msg.includes("rate limit") || msg.includes("429")) return true;
    if (msg.includes("timeout") || msg.includes("etimedout")) return true;
    if (msg.includes("econnreset") || msg.includes("network")) return true;
    if (/\b5\d\d\b/.test(msg)) return true;
    if (msg.includes("401") || msg.includes("402") || msg.includes("auth")) return true;
    return false;
  }

  /**
   * Parse the model's raw response into an `AgentOutput`. Tolerant to
   * three shapes:
   *  - Full envelope: { thinking, evaluation_previous_goal, action, ... }
   *  - Raw action object (legacy / `useThinking: false`)
   *  - Raw action array
   *
   * Also strips ```json fences the model occasionally adds.
   */
  private parseEnvelope(raw: string): AgentOutput | null {
    if (!raw) return null;
    let s = raw.trim();
    // Strip fenced code blocks.
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) s = fence[1].trim();
    let json: any;
    try {
      json = JSON.parse(s);
    } catch {
      // Tolerant pass — try to find the first { ... } or [ ... ] block.
      const m = s.match(/[[{][\s\S]*[\]}]/);
      if (!m) return null;
      try {
        json = JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    if (Array.isArray(json)) return { action: json as BrowserAction[] };
    if (json && typeof json === "object" && typeof (json as any).action === "string") {
      return { action: json as BrowserAction };
    }
    if (json && typeof json === "object" && "action" in json) {
      // Full envelope. Accept both camelCase and snake_case field names.
      const out: AgentOutput = { action: (json as any).action };
      out.thinking = (json as any).thinking ?? (json as any).reasoning ?? undefined;
      out.evaluationPreviousGoal =
        (json as any).evaluationPreviousGoal ?? (json as any).evaluation_previous_goal ?? undefined;
      out.memory = (json as any).memory ?? undefined;
      out.nextGoal = (json as any).nextGoal ?? (json as any).next_goal ?? undefined;
      return out;
    }
    return null;
  }

  /**
   * Quick post-navigation health check. If the page came back blank
   * (no body text and no interactive elements), reload once and wait
   * for stable. This catches the "FreightOS half-loaded font test" class
   * of failure before the LLM ever sees it.
   */
  private async navigationHealthCheck(browser: BrowserProvider, url: string): Promise<void> {
    try {
      const ok = await browser.pageText({ maxChars: 200 }).catch(() => "");
      if (ok && ok.trim().length > 5) return;
      // Empty body — try reload once.
      this.logger.warn("Navigation produced an empty page; reloading once", { url });
      await this.sleep(800);
      try {
        await browser.navigate(url);
      } catch {
        /* ignore */
      }
    } catch {
      /* health check is best-effort */
    }
  }

  /**
   * Force-finalize the run with whatever partial data the agent has.
   * Called when:
   *   - `maxSteps` is exhausted without an explicit `done`,
   *   - `maxFailures` is exceeded,
   *   - the model can't produce parseable JSON enough times to make
   *     forward progress.
   * The result is composed from `extractedContent` + the last few
   * action summaries so the caller gets something useful instead of
   * just a one-line error.
   */
  private async forceDone(
    browser: BrowserProvider,
    steps: BrowserStep[],
    startTime: number,
    opts: BrowserRunOpts | undefined,
    extractedContent: string[],
    actionHistory: string[],
    reason: "model" | "parse" | "max_steps",
  ): Promise<BrowserRunOutput> {
    const reasonLine =
      reason === "model"
        ? "Model call failed too many consecutive times."
        : reason === "parse"
          ? "Model produced invalid JSON too many times."
          : "Max step budget exhausted before an explicit `done`.";
    const tail = actionHistory.slice(-5).join(" → ");
    const extracts = extractedContent.length > 0 ? `\n\nExtracts so far:\n${extractedContent.join("\n---\n")}` : "";
    const result = `${reasonLine}\nLast actions: ${tail || "(none)"}${extracts}`;
    return await this.finalize(browser, steps, startTime, opts, extractedContent, {
      result,
      success: false,
    });
  }

  private async finalize(
    browser: BrowserProvider,
    steps: BrowserStep[],
    startTime: number,
    opts: BrowserRunOpts | undefined,
    extractedContent: string[],
    outcome: { result: string; success: boolean },
  ): Promise<BrowserRunOutput> {
    let finalScreenshot: Buffer;
    let finalInfo: { url: string; title: string };
    try {
      finalScreenshot = await browser.screenshot();
      finalInfo = await browser.getPageInfo();
    } catch {
      finalScreenshot = Buffer.alloc(0);
      finalInfo = { url: "", title: "" };
    }

    if (opts?.saveStorageState) {
      try {
        await browser.saveStorageState(opts.saveStorageState);
        this.logger.info("Storage state saved", { path: opts.saveStorageState });
      } catch (e: any) {
        this.logger.warn("Failed to save storage state", { error: e.message });
      }
    }

    let videoPath: string | undefined;
    if (this.recordVideo) {
      videoPath = (await browser.getVideoPath()) ?? undefined;
    }

    await browser.close();

    const output: BrowserRunOutput = {
      result: outcome.result,
      success: outcome.success,
      steps,
      finalUrl: finalInfo.url,
      finalScreenshot,
      durationMs: Date.now() - startTime,
      videoPath,
      extractedContent,
    };

    if (this.memoryManager) {
      const sessionId = opts?.sessionId ?? `browser_${startTime}`;
      const userId = opts?.userId;
      const actionSummary = steps
        .map((s) => summarizeAction(s.action as unknown as Record<string, unknown>))
        .join("; ");

      const messages: ChatMessage[] = [
        { role: "user", content: `Task: ${outcome.result}` },
        { role: "assistant", content: `Actions: ${actionSummary}. Result: ${outcome.result}` },
      ];

      this.memoryManager
        .appendMessages(sessionId, messages, this.model)
        .catch((e) => this.logger.warn("Memory persist failed", { error: String(e) }));

      try {
        this.memoryManager.afterRun(sessionId, userId, messages, this.model, this.name);
      } catch (e) {
        this.logger.warn("Memory afterRun failed", { error: String(e) });
      }
    }

    this.eventBus.emit("browser.done", {
      result: output.result,
      success: outcome.success,
      steps,
    });

    return output;
  }

  /**
   * Execute a single action. Returns `{ output?, didNavigate? }` for the
   * caller's state tracking. May throw — the loop handles failure-budget
   * accounting in that case.
   */
  private async executeAction(
    browser: BrowserProvider,
    action: BrowserAction,
    _actionHistory: string[],
    extractedContent: string[],
  ): Promise<{ output?: string; didNavigate?: boolean }> {
    switch (action.action) {
      case "click": {
        // Indexed click is the most reliable path.
        if (typeof action.index === "number") {
          const ok = await browser.clickByIndex(action.index);
          if (ok) return {};
        }
        // Text-locator fallback from action.description.
        const keyword = this.extractClickKeyword(action.description);
        if (keyword && (await browser.clickByText(keyword))) {
          this.logger.debug("Clicked by text", { keyword });
          return {};
        }
        // Coordinate fallback.
        if (typeof action.x === "number" && typeof action.y === "number") {
          await browser.click(action.x, action.y);
          return {};
        }
        throw new Error(`click action has no resolvable target (index/text/coordinates)`);
      }

      case "type": {
        const resolvedText = this.credentials ? this.credentials.resolve(action.text) : action.text;
        const submit = action.submit ?? resolvedText.includes("\n");
        const cleanText = submit ? resolvedText.replace(/\n+$/, "") : resolvedText;

        if (typeof action.index === "number") {
          const ok = await browser.inputByIndex(action.index, cleanText, {
            clear: action.clear,
            submit,
          });
          if (ok) return {};
        }
        if (typeof action.x === "number" && typeof action.y === "number") {
          await browser.clickAndType(action.x, action.y, cleanText);
          if (submit) await browser.pressKey("Enter");
          return {};
        }
        // No target: type into the currently focused element.
        await browser.type(cleanText);
        if (submit) await browser.pressKey("Enter");
        return {};
      }

      case "scroll": {
        if (typeof action.index === "number") {
          await browser.scrollIntoViewByIndex(action.index);
          return {};
        }
        await browser.scroll(action.direction, action.amount);
        return {};
      }

      case "navigate": {
        this.assertDomainAllowed(action.url);
        await browser.navigate(action.url);
        return { didNavigate: true };
      }

      case "back":
        await browser.back();
        return { didNavigate: true };

      case "wait":
        await this.sleep(Math.min(action.ms, 10_000));
        return {};

      case "screenshot":
        // Handled by the main loop's vision logic — no-op here.
        return {};

      case "send_keys":
        await browser.sendKeys(action.keys);
        return {};

      case "find_text":
        await browser.findText(action.text);
        return {};

      case "evaluate": {
        if (!this.allowEvaluate) {
          throw new Error("evaluate is disabled. Set allowEvaluate: true on BrowserAgent to enable.");
        }
        const out = await browser.evaluate(action.code);
        return { output: `evaluate → ${out}` };
      }

      case "dropdown_options": {
        const options = await browser.dropdownOptions(action.index);
        const formatted = options
          .map((o, i) => `${i + 1}. "${o.label}" (value="${o.value}")${o.selected ? " [selected]" : ""}`)
          .join("\n");
        return { output: `Dropdown [${action.index}] options:\n${formatted || "(no options found)"}` };
      }

      case "select_dropdown": {
        const ok = await browser.selectDropdown(action.index, action.text);
        if (!ok) throw new Error(`Could not select "${action.text}" on dropdown [${action.index}]`);
        return {};
      }

      case "upload_file": {
        const ok = await browser.uploadFileByIndex(action.index, action.path);
        if (!ok) throw new Error(`Could not upload "${action.path}" to [${action.index}]`);
        return {};
      }

      case "extract": {
        const pageText = await browser.pageText({ extractLinks: action.extractLinks });
        const model = this.pageExtractionLLM ?? this.model;
        const messages: ChatMessage[] = [
          {
            role: "system",
            content:
              "You extract information from web pages. Use ONLY the page content provided. If the requested information is not present, say so explicitly. Be concise and structured (lists/tables) when appropriate.",
          },
          {
            role: "user",
            content: `Query: ${action.query}\n\nPage content:\n${pageText}`,
          },
        ];
        const response = await model.generate(messages, { temperature: 0.0, maxTokens: 2048 });
        const out = typeof response.message.content === "string" ? response.message.content : "";
        const masked = this.credentials ? this.credentials.mask(out) : out;
        extractedContent.push(masked);
        return { output: masked };
      }

      case "tool": {
        const tool = this.tools.find((t) => t.name === action.name);
        if (!tool) throw new Error(`Tool "${action.name}" is not registered on this BrowserAgent`);
        const ctx = new RunContext({
          sessionId: `browser_${this.name}_${Date.now()}`,
          eventBus: this.eventBus,
        });
        const result = await tool.execute((action.args ?? {}) as Record<string, unknown>, ctx);
        const out = typeof result === "string" ? result : JSON.stringify(result);
        return { output: `${action.name} → ${out}` };
      }

      // `done` and `fail` are intercepted by the run loop before we get
      // here. Listing them keeps the discriminated union exhaustive.
      case "done":
      case "fail":
        return {};
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse a quoted target keyword from a click action's `description`.
   * Returns `undefined` for generic / ambiguous labels (login buttons,
   * close, OK, etc.) where a substring text match could fire on the
   * wrong element.
   */
  private extractClickKeyword(description: string | undefined): string | undefined {
    if (!description) return undefined;
    const match = description.match(
      /['"\u2018\u2019\u201C\u201D]([^'"\u2018\u2019\u201C\u201D]{1,80})['"\u2018\u2019\u201C\u201D]/,
    );
    if (!match) return undefined;
    const keyword = match[1].trim();
    if (!keyword || keyword.length < 2) return undefined;
    const skip = new Set([
      "log in",
      "login",
      "sign in",
      "sign up",
      "submit",
      "close",
      "ok",
      "okay",
      "cancel",
      "yes",
      "no",
      "x",
      "continue",
      "next",
      "back",
      "accept",
      "dismiss",
      "got it",
      "agree",
      "i agree",
      "allow",
      "deny",
    ]);
    if (skip.has(keyword.toLowerCase())) return undefined;
    return keyword;
  }
}

/**
 * Domain wildcard matcher. Supports:
 *   "example.com"       — exact match
 *   "*.example.com"     — example.com and any subdomain
 *   "*"                 — anything
 * Case-insensitive.
 */
function matchDomain(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  // Strip protocol prefix from patterns like "http*://example.com" → "example.com"
  let p = pattern
    .toLowerCase()
    .replace(/^https?\*?:\/\//, "")
    .replace(/^\/+/, "");
  if (p.includes("/")) p = p.split("/")[0];
  if (p === "*") return true;
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return false;
}
