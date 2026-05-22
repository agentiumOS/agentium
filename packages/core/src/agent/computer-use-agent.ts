import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Wrapper around Anthropic's Computer Use API (`computer_20251124`).
 *
 * Implements the agent loop where Claude returns desktop actions (mouse/keyboard
 * /screenshot/zoom), the caller-supplied `executor` performs them, and the
 * loop continues until the model returns a final non-tool message.
 *
 * The executor is pluggable so the same Agent can run against:
 *   - local OS desktops (via `xdotool` + screenshot)
 *   - remote VNC sessions
 *   - sandboxed Linux containers (e.g. an `E2BSandbox` from Phase 4.1)
 *
 * Spec: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool
 */

export type ComputerAction =
  | { action: "screenshot" }
  | { action: "mouse_move"; coordinate: [number, number] }
  | { action: "left_click"; coordinate?: [number, number] }
  | { action: "right_click"; coordinate?: [number, number] }
  | { action: "double_click"; coordinate?: [number, number] }
  | { action: "left_click_drag"; coordinate: [number, number] }
  | { action: "type"; text: string }
  | { action: "key"; text: string }
  | {
      action: "scroll";
      coordinate: [number, number];
      scroll_direction: "up" | "down" | "left" | "right";
      scroll_amount: number;
    }
  | { action: "zoom"; region: [number, number, number, number] };

export interface ComputerActionResult {
  /** Optional human-readable output (e.g. an error message). */
  output?: string;
  /** Base64-encoded PNG of the screen after the action. */
  screenshotBase64?: string;
}

export interface ComputerExecutor {
  /** Display width in pixels. */
  readonly displayWidth: number;
  /** Display height in pixels. */
  readonly displayHeight: number;
  /** X11 display number, if applicable. Optional. */
  readonly displayNumber?: number;
  /** Execute a single action and return the result. */
  execute(action: ComputerAction): Promise<ComputerActionResult>;
}

export interface ComputerUseAgentConfig {
  /** Anthropic API key. Falls back to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Claude model id. Defaults to a known computer-use-compatible model. */
  model?: string;
  /** Maximum response tokens. Default 4096. */
  maxTokens?: number;
  /** Executor that performs OS-level actions and returns screenshots. */
  executor: ComputerExecutor;
  /** Maximum agent loop iterations (one LLM call per iteration). Default 50. */
  maxIterations?: number;
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
  /** Enable zoom action (only on `computer_20251124`). Default true. */
  enableZoom?: boolean;
}

export interface ComputerUseRunOutput {
  /** Final assistant text. */
  text: string;
  /** All actions taken during the run. */
  actions: ComputerAction[];
  /** Number of LLM iterations consumed. */
  iterations: number;
}

export class ComputerUseAgent {
  readonly kind = "computer-use-agent" as const;
  private client: any;
  private model: string;
  private maxTokens: number;
  private executor: ComputerExecutor;
  private maxIterations: number;
  private systemPrompt?: string;
  private enableZoom: boolean;

  constructor(config: ComputerUseAgentConfig) {
    this.model = config.model ?? "claude-sonnet-4-20250514";
    this.maxTokens = config.maxTokens ?? 4096;
    this.executor = config.executor;
    this.maxIterations = config.maxIterations ?? 50;
    this.systemPrompt = config.systemPrompt;
    this.enableZoom = config.enableZoom ?? true;

    try {
      const Anthropic = _require("@anthropic-ai/sdk").default ?? _require("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY });
    } catch (e: any) {
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(
          "@anthropic-ai/sdk is required for ComputerUseAgent. Install it: npm install @anthropic-ai/sdk",
        );
      }
      throw e;
    }
  }

  private buildTool(): any {
    return {
      type: "computer_20251124",
      name: "computer",
      display_width_px: this.executor.displayWidth,
      display_height_px: this.executor.displayHeight,
      ...(this.executor.displayNumber != null ? { display_number: this.executor.displayNumber } : {}),
      ...(this.enableZoom ? { enable_zoom: true } : {}),
    };
  }

  /** Run the computer-use loop until the model returns a final assistant turn. */
  async run(input: string): Promise<ComputerUseRunOutput> {
    const messages: any[] = [{ role: "user", content: input }];
    const actions: ComputerAction[] = [];

    for (let iter = 0; iter < this.maxIterations; iter++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(this.systemPrompt ? { system: this.systemPrompt } : {}),
        tools: [this.buildTool()],
        messages,
        betas: ["computer-use-2025-11-24"],
      });

      // Append assistant content to history.
      messages.push({ role: "assistant", content: response.content });

      // Collect any tool_use blocks the model emitted.
      const toolUses: any[] = (response.content ?? []).filter((b: any) => b.type === "tool_use");

      if (toolUses.length === 0) {
        // Final answer - grab any text blocks.
        const text = (response.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        return { text, actions, iterations: iter + 1 };
      }

      // Execute each tool_use sequentially and append a single user-tool_result message.
      const toolResults: any[] = [];
      for (const use of toolUses) {
        const action = use.input as ComputerAction;
        actions.push(action);
        const result = await this.executor.execute(action);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: [
            ...(result.output ? [{ type: "text", text: result.output }] : []),
            ...(result.screenshotBase64
              ? [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: result.screenshotBase64 },
                  },
                ]
              : []),
          ],
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return { text: "[max iterations reached without final answer]", actions, iterations: this.maxIterations };
  }
}
