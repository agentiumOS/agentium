import type { ChatMessage, CostTracker, ModelProvider, ToolDef } from "@agentium/core";
import { EventBus, Logger, MemoryManager } from "@agentium/core";
import { z } from "zod";
import { BrowserProvider } from "./browser-provider.js";
import type { CredentialVault } from "./credential-vault.js";
import { buildSystemPrompt, buildUserMessage, summarizeAction } from "./prompts.js";
import type { BrowserAction, BrowserAgentConfig, BrowserRunOpts, BrowserRunOutput, BrowserStep } from "./types.js";

export class BrowserAgent {
  readonly name: string;
  readonly eventBus: EventBus;

  private model: ModelProvider;
  private instructions?: string;
  private maxSteps: number;
  private headless: boolean;
  private viewport: { width: number; height: number };
  private defaultStartUrl?: string;
  private waitAfterAction: number;
  private maxRepeats: number;
  private useDOM: boolean;
  private storageState?: string;
  private recordVideo?: boolean | { dir: string };
  private credentials?: CredentialVault;
  private stealth?: boolean | import("./types.js").StealthConfig;
  private humanize?: boolean | import("./types.js").HumanizeConfig;
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
    this.instructions = config.instructions;
    this.maxSteps = config.maxSteps ?? 30;
    this.headless = config.headless ?? true;
    this.viewport = config.viewport ?? { width: 1280, height: 720 };
    this.defaultStartUrl = config.startUrl;
    this.waitAfterAction = config.waitAfterAction ?? 1500;
    this.maxRepeats = config.maxRepeats ?? 3;
    this.useDOM = config.useDOM ?? false;
    this.storageState = config.storageState;
    this.recordVideo = config.recordVideo;
    this.credentials = config.credentials;
    this.stealth = config.stealth;
    this.humanize = config.humanize;
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
    const startUrl = opts?.startUrl ?? this.defaultStartUrl;
    const sessionId = opts?.sessionId ?? `browser_${Date.now()}`;
    const userId = opts?.userId;
    const browser = new BrowserProvider();
    const steps: BrowserStep[] = [];
    const actionHistory: string[] = [];

    let extraInstructions = this.instructions ?? "";
    if (this.memoryManager) {
      await this.memoryManager.ensureReady();
      const memoryContext = await this.memoryManager.buildContext(sessionId, userId, task, this.name);
      if (memoryContext) {
        extraInstructions = extraInstructions ? `${extraInstructions}\n\n${memoryContext}` : memoryContext;
      }
    }

    const credentialKeys = this.credentials?.keys();
    const systemPrompt = buildSystemPrompt(this.viewport, extraInstructions || undefined, credentialKeys);
    let lastActionKey = "";
    let repeatCount = 0;

    try {
      this.logger.info("Launching browser", {
        headless: this.headless,
        viewport: this.viewport,
        useDOM: this.useDOM,
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
      });

      if (startUrl) {
        this.logger.info("Navigating to start URL", { url: startUrl });
        await browser.navigate(startUrl);
      }

      for (let step = 0; step < this.maxSteps; step++) {
        const screenshot = await browser.screenshot();
        const pageInfo = await browser.getPageInfo();

        let domSnapshot: string | undefined;
        if (this.useDOM) {
          domSnapshot = await browser.extractDOM();
        }

        this.eventBus.emit("browser.screenshot", { data: screenshot });

        const userText = buildUserMessage(task, pageInfo.url, pageInfo.title, step, actionHistory, domSnapshot);

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image",
                data: screenshot.toString("base64"),
                mimeType: "image/png",
              },
              { type: "text", text: userText },
            ],
          },
        ];

        this.logger.debug("Sending screenshot to vision model", { step, url: pageInfo.url });

        const response = await this.model.generate(messages, {
          temperature: 0.1,
          maxTokens: 1024,
          apiKey: opts?.apiKey,
          responseFormat: "json",
        });

        if (this.costTracker && response.usage) {
          this.costTracker.track({
            runId: sessionId,
            agentName: this.name,
            modelId: this.model.modelId,
            usage: response.usage,
            sessionId,
            userId,
          });
        }

        const raw = typeof response.message.content === "string" ? response.message.content : "";

        let action: BrowserAction;
        try {
          action = JSON.parse(raw) as BrowserAction;
        } catch {
          this.logger.warn("Failed to parse model response as JSON, retrying", { raw });
          actionHistory.push("(invalid JSON response — retrying)");
          continue;
        }

        // Store the sanitized action (with placeholders) in step history
        const step_: BrowserStep = {
          index: step,
          action,
          screenshot,
          pageUrl: pageInfo.url,
          pageTitle: pageInfo.title,
          timestamp: new Date(),
          dom: domSnapshot,
        };
        steps.push(step_);

        let summary = summarizeAction(action as unknown as Record<string, unknown>);
        if (this.credentials) {
          summary = this.credentials.mask(summary);
        }

        // ── Loop detection ─────────────────────────────────────────────
        const actionKey = JSON.stringify(action);
        if (actionKey === lastActionKey) {
          repeatCount++;
        } else {
          lastActionKey = actionKey;
          repeatCount = 1;
        }

        if (repeatCount > this.maxRepeats && action.action !== "done" && action.action !== "fail") {
          this.logger.warn("Stuck in a loop — same action repeated", {
            action: action.action,
            repeats: repeatCount,
            maxRepeats: this.maxRepeats,
          });
          actionHistory.push(
            `⚠ LOOP DETECTED: "${summary}" repeated ${repeatCount} times. ` +
              `The agent was stuck and auto-stopped. Try a different approach or a different startUrl.`,
          );

          return await this.finalize(browser, steps, startTime, opts, {
            result: `Stuck in a loop: "${summary}" was repeated ${repeatCount} times. The page may have a popup, consent banner, or unexpected state blocking progress.`,
            success: false,
          });
        }

        actionHistory.push(summary);
        this.logger.info(`Step ${step + 1}: ${summary}`);

        this.eventBus.emit("browser.action", { action });
        this.eventBus.emit("browser.step", {
          index: step,
          action,
          pageUrl: pageInfo.url,
          screenshot,
        });

        if (action.action === "done") {
          const result = this.credentials ? this.credentials.mask(action.result) : action.result;
          return await this.finalize(browser, steps, startTime, opts, {
            result,
            success: true,
          });
        }

        if (action.action === "fail") {
          const result = this.credentials ? this.credentials.mask(action.reason) : action.reason;
          return await this.finalize(browser, steps, startTime, opts, {
            result,
            success: false,
          });
        }

        await this.executeAction(browser, action);
        await this.sleep(this.waitAfterAction);
      }

      // Max steps exhausted
      this.logger.warn("Max steps reached without completing task", { maxSteps: this.maxSteps });
      return await this.finalize(browser, steps, startTime, opts, {
        result: `Task not completed within ${this.maxSteps} steps. Last actions: ${actionHistory.slice(-3).join("; ")}`,
        success: false,
      });
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

  private async finalize(
    browser: BrowserProvider,
    steps: BrowserStep[],
    startTime: number,
    opts: BrowserRunOpts | undefined,
    outcome: { result: string; success: boolean },
  ): Promise<BrowserRunOutput> {
    const finalScreenshot = await browser.screenshot();
    const finalInfo = await browser.getPageInfo();

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

  private async executeAction(browser: BrowserProvider, action: BrowserAction): Promise<void> {
    try {
      switch (action.action) {
        case "click":
          await browser.click(action.x, action.y);
          break;

        case "type": {
          const resolvedText = this.credentials ? this.credentials.resolve(action.text) : action.text;

          if (action.x != null && action.y != null) {
            await browser.clickAndType(action.x, action.y, resolvedText);
          } else {
            await browser.type(resolvedText);
          }
          if (resolvedText.includes("\n")) {
            await browser.pressKey("Enter");
          }
          break;
        }

        case "scroll":
          await browser.scroll(action.direction, action.amount);
          break;

        case "navigate":
          await browser.navigate(action.url);
          break;

        case "back":
          await browser.back();
          break;

        case "wait":
          await this.sleep(Math.min(action.ms, 10_000));
          break;

        case "screenshot":
          break;

        default:
          this.logger.warn("Unknown action", { action });
      }
    } catch (error: any) {
      this.logger.warn("Action execution failed", { action: action.action, error: error.message });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
