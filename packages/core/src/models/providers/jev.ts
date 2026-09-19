import {
  buildJevState,
  createTypeSafeClient,
  flattenJevAnswers,
  JEV_SDK_INSTALL,
  type JevQuestions,
  mapJevUsage,
  pickToolName,
  questionsFromJsonSchema,
  questionsFromTools,
  type SchemaQuestionPlan,
} from "../jev-sdk.js";
import type { ModelProvider } from "../provider.js";
import type { ChatMessage, ModelConfig, ModelResponse, StreamChunk, ToolCall, ToolDefinition } from "../types.js";

export interface JevConfig {
  /** TypeSafe API key. Falls back to `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** TypeSafe API root. Falls back to `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`. */
  baseURL?: string;
  /**
   * Named TypeSafe questions (`choice` / `noul` / `score`).
   * When set, these win over `structuredOutput` schema and auto tool-choice.
   */
  questions?: JevQuestions;
}

/**
 * Jev (TypeSafe System One) — decisions, not chat.
 *
 * `generate()` maps messages → `state`, asks typed questions, and returns
 * JSON answers (or a single closed-set `tool_calls` finish).
 */
export class JevProvider implements ModelProvider {
  readonly providerId = "jev";
  readonly modelId: string;
  private readonly config: JevConfig;
  /** Tests assign a mock client here. */
  client: any;

  constructor(modelId = "jev-latest", config?: JevConfig) {
    this.modelId = modelId;
    this.config = config ?? {};
  }

  private getClient(apiKey?: string): any {
    if (this.client && !apiKey) return this.client;
    try {
      const created = createTypeSafeClient({
        apiKey: apiKey ?? this.config.apiKey,
        baseURL: this.config.baseURL,
        defaultModel: this.modelId,
      });
      if (!apiKey) this.client = created;
      return created;
    } catch (e: any) {
      if (e?.message === JEV_SDK_INSTALL) throw e;
      if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(JEV_SDK_INSTALL);
      }
      throw e;
    }
  }

  private resolveQuestions(options?: ModelConfig & { tools?: ToolDefinition[] }): {
    questions: JevQuestions;
    plan?: SchemaQuestionPlan;
  } {
    if (this.config.questions && Object.keys(this.config.questions).length > 0) {
      return { questions: this.config.questions };
    }

    const format = options?.responseFormat;
    if (format && typeof format === "object" && format.type === "json_schema" && format.schema) {
      const plan = questionsFromJsonSchema(format.schema);
      return { questions: plan.questions, plan };
    }

    if (options?.tools && options.tools.length > 0) {
      return { questions: questionsFromTools(options.tools) };
    }

    throw new Error(
      "Jev has nothing to ask. Pass questions on jev(model, { questions }), set Agent structuredOutput to enums/booleans/bounded numbers, or give the agent closed-set tools.",
    );
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): Promise<ModelResponse> {
    const { questions, plan } = this.resolveQuestions(options);
    const client = this.getClient(options?.apiKey);
    const state = buildJevState(messages);

    const result = await client.systemOne({
      state,
      questions,
      model: this.modelId,
    });

    const answers = (result?.answers ?? {}) as Record<string, unknown>;
    const toolNames = new Set((options?.tools ?? []).map((t) => t.name));
    const toolName = pickToolName(answers, toolNames);

    const usage = mapJevUsage(result?.usage);
    const content = JSON.stringify(plan?.flatten ? flattenJevAnswers(answers, plan.numericMin) : answers);

    if (toolName) {
      const toolCall: ToolCall = { id: `call_jev_${toolName}`, name: toolName, arguments: {} };
      return {
        message: { role: "assistant", content, toolCalls: [toolCall] },
        usage,
        finishReason: "tool_calls",
        raw: result,
      };
    }

    return {
      message: { role: "assistant", content },
      usage,
      finishReason: "stop",
      raw: result,
    };
  }

  async *stream(
    messages: ChatMessage[],
    options?: ModelConfig & { tools?: ToolDefinition[] },
  ): AsyncGenerator<StreamChunk> {
    const response = await this.generate(messages, options);
    const text = typeof response.message.content === "string" ? response.message.content : "";
    if (text) yield { type: "text", text };
    if (response.message.toolCalls) {
      for (const tc of response.message.toolCalls) {
        yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.name } };
        yield { type: "tool_call_end", toolCallId: tc.id };
      }
    }
    yield { type: "finish", finishReason: response.finishReason, usage: response.usage };
  }
}
