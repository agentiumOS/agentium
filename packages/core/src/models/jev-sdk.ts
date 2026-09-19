import { createRequire } from "node:module";
import { type ChatMessage, getTextContent, type TokenUsage, type ToolDefinition } from "./types.js";

const _require = createRequire(import.meta.url);

export const JEV_SDK_INSTALL = "@typesafe-ai/sdk is required for Jev. Install it: npm install @typesafe-ai/sdk";

export type JevQuestions = Record<string, unknown>;

export interface SchemaQuestionPlan {
  questions: JevQuestions;
  /** When true, stringify flattened primitives so Agent `structuredOutput` can parse. */
  flatten: boolean;
  /** Score answers are 0-indexed; add this offset to match the original min. */
  numericMin: Record<string, number>;
}

let cachedSdk: any;

export function tryLoadTypeSafeSdk(): any | null {
  if (cachedSdk !== undefined) return cachedSdk;
  try {
    cachedSdk = _require("@typesafe-ai/sdk");
    return cachedSdk;
  } catch (e: any) {
    if (e?.code === "MODULE_NOT_FOUND" || e?.code === "ERR_MODULE_NOT_FOUND") {
      cachedSdk = null;
      return null;
    }
    throw e;
  }
}

export function loadTypeSafeSdk(): any {
  const sdk = tryLoadTypeSafeSdk();
  if (!sdk) throw new Error(JEV_SDK_INSTALL);
  return sdk;
}

export function createTypeSafeClient(config?: { apiKey?: string; baseURL?: string; defaultModel?: string }): any {
  const sdk = loadTypeSafeSdk();
  const TypeSafeClient = sdk.TypeSafeClient ?? sdk.default?.TypeSafeClient ?? sdk.default;
  return new TypeSafeClient({
    apiKey: config?.apiKey ?? process.env.TYPESAFE_API_KEY,
    baseURL: config?.baseURL,
    defaultModel: config?.defaultModel,
  });
}

/** Lazy TypeSafe `choice()`, or the wire-format object if the SDK is not installed. */
export function choice(instructions: unknown, criteria: Record<string, unknown>): unknown {
  const sdk = tryLoadTypeSafeSdk();
  if (sdk?.choice) return sdk.choice(instructions, criteria);
  return { type: "choice", instructions, criteria };
}

/** Lazy TypeSafe `noul()`, or the wire-format object if the SDK is not installed. */
export function noul(instructions?: unknown, criteria?: unknown): unknown {
  const sdk = tryLoadTypeSafeSdk();
  if (sdk?.noul) return sdk.noul(instructions, criteria);
  return { type: "noul", instructions: instructions ?? null, criteria: criteria ?? null };
}

/** Lazy TypeSafe `score()`. Criteria is an ordered rubric of at least two levels. */
export function score(instructions: unknown, criteria: unknown[]): unknown {
  const sdk = tryLoadTypeSafeSdk();
  if (sdk?.score) return sdk.score(instructions, criteria);
  return { type: "score", instructions, criteria };
}

export function buildJevState(messages: ChatMessage[]): unknown {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = getTextContent(lastUser?.content ?? null).trim();

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      // keep as text
    }
  }

  const history = messages
    .filter((m) => m !== lastUser)
    .map((m) => ({ role: m.role, content: getTextContent(m.content) }))
    .filter((m) => m.content);

  if (history.length === 0) return text;
  return { input: text, history };
}

export function mapJevUsage(usage: { input_tokens?: number; output_tokens?: number } | undefined): TokenUsage {
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage ? { providerMetrics: usage as unknown as Record<string, unknown> } : {}),
  };
}

export function questionsFromTools(tools: ToolDefinition[]): JevQuestions {
  const criteria: Record<string, unknown> = { none: "Do not call a tool" };
  for (const tool of tools) {
    criteria[tool.name] = tool.description || null;
  }
  return {
    __tool__: choice("Which tool should run for this request? Pick none if no tool is needed.", criteria),
  };
}

const MAX_SCORE_LEVELS = 32;

function unwrapSchemaProp(prop: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(prop.anyOf) || Array.isArray(prop.oneOf)) {
    const alts = (prop.anyOf ?? prop.oneOf) as Record<string, unknown>[];
    const useful = alts.find(
      (a) => a && a.type !== "null" && !(Array.isArray(a.type) && a.type.length === 1 && a.type[0] === "null"),
    );
    if (useful) return { ...useful, description: prop.description ?? useful.description };
  }
  return prop;
}

function typesOf(prop: Record<string, unknown>): string[] {
  if (typeof prop.type === "string") return [prop.type];
  if (Array.isArray(prop.type)) return prop.type.filter((t): t is string => typeof t === "string");
  return [];
}

export function questionsFromJsonSchema(schema: Record<string, unknown>): SchemaQuestionPlan {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== "object") {
    throw new Error("Jev structuredOutput must be a Zod object with properties (enums, booleans, or bounded numbers).");
  }

  const questions: JevQuestions = {};
  const numericMin: Record<string, number> = {};

  for (const [name, raw] of Object.entries(properties)) {
    const prop = unwrapSchemaProp(raw ?? {});
    const description = typeof prop.description === "string" && prop.description ? prop.description : name;
    const types = typesOf(prop);
    const enumVals = Array.isArray(prop.enum) ? prop.enum : undefined;

    if (enumVals && enumVals.length > 0) {
      const criteria: Record<string, unknown> = {};
      for (const value of enumVals) {
        criteria[String(value)] = null;
      }
      questions[name] = choice(description, criteria);
      continue;
    }

    if (types.includes("boolean")) {
      questions[name] = noul(description);
      continue;
    }

    if (types.includes("integer") || types.includes("number")) {
      const min = typeof prop.minimum === "number" ? prop.minimum : undefined;
      const max = typeof prop.maximum === "number" ? prop.maximum : undefined;
      if (min === undefined || max === undefined) {
        throw new Error(`Jev cannot map "${name}": number fields need minimum and maximum.`);
      }
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error(`Jev cannot map "${name}": minimum/maximum must be integers with max >= min.`);
      }
      const levels = max - min + 1;
      if (levels < 2 || levels > MAX_SCORE_LEVELS) {
        throw new Error(`Jev cannot map "${name}": number range must be 2–${MAX_SCORE_LEVELS} integer levels.`);
      }
      const criteria = Array.from({ length: levels }, (_, i) => String(min + i));
      questions[name] = score(description, criteria);
      numericMin[name] = min;
      continue;
    }

    throw new Error(
      `Jev cannot map "${name}": use z.enum, z.boolean, or z.number().min().max() — free-form strings and open objects are not questions.`,
    );
  }

  if (Object.keys(questions).length === 0) {
    throw new Error("Jev structuredOutput produced no questions.");
  }

  return { questions, flatten: true, numericMin };
}

export function flattenJevAnswers(
  answers: Record<string, unknown>,
  numericMin: Record<string, number> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!value || typeof value !== "object") {
      out[key] = value;
      continue;
    }
    const rec = value as Record<string, unknown>;
    if (typeof rec.choice === "string") {
      out[key] = rec.choice;
    } else if (typeof rec.noul === "number") {
      out[key] = rec.noul >= 0.5;
    } else if (typeof rec.score === "number") {
      // TypeSafe may return a fractional expected index (e.g. 2.46).
      out[key] = (numericMin[key] ?? 0) + Math.round(rec.score);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function pickToolName(answers: Record<string, unknown>, toolNames: Set<string>): string | undefined {
  const toolAnswer = answers.__tool__;
  if (toolAnswer && typeof toolAnswer === "object") {
    const picked = (toolAnswer as { choice?: string }).choice;
    if (picked && picked !== "none" && toolNames.has(picked)) return picked;
  }
  for (const [key, value] of Object.entries(answers)) {
    if (key === "__tool__" || !value || typeof value !== "object") continue;
    const picked = (value as { choice?: string }).choice;
    if (picked && picked !== "none" && toolNames.has(picked)) return picked;
  }
  return undefined;
}

/** Convert toolkit / jev_ask JSON specs into TypeSafe questions. */
export function questionsFromSpecs(specs: Record<string, unknown>): JevQuestions {
  const questions: JevQuestions = {};
  for (const [name, raw] of Object.entries(specs)) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Jev question "${name}" must be an object with type choice | score | noul.`);
    }
    const spec = raw as Record<string, unknown>;
    const type = spec.type ?? inferSpecType(spec);
    const instructions = spec.question ?? spec.instructions ?? spec.statement ?? name;

    if (type === "choice") {
      questions[name] = choice(instructions, normalizeChoiceCriteria(spec));
    } else if (type === "noul") {
      questions[name] = noul(instructions, spec.criteria);
    } else if (type === "score") {
      questions[name] = score(instructions, normalizeScoreCriteria(spec));
    } else {
      throw new Error(`Jev question "${name}" has unknown type "${String(type)}". Use choice, score, or noul.`);
    }
  }
  return questions;
}

function inferSpecType(spec: Record<string, unknown>): string | undefined {
  if (spec.options || (spec.criteria && !Array.isArray(spec.criteria) && spec.criteria !== null)) return "choice";
  if (spec.levels || Array.isArray(spec.criteria)) return "score";
  if (spec.statement) return "noul";
  return undefined;
}

function normalizeChoiceCriteria(spec: Record<string, unknown>): Record<string, unknown> {
  if (spec.options && typeof spec.options === "object" && !Array.isArray(spec.options)) {
    return spec.options as Record<string, unknown>;
  }
  if (Array.isArray(spec.options)) {
    const criteria: Record<string, unknown> = {};
    for (const opt of spec.options) criteria[String(opt)] = null;
    return criteria;
  }
  if (spec.criteria && typeof spec.criteria === "object" && !Array.isArray(spec.criteria)) {
    return spec.criteria as Record<string, unknown>;
  }
  throw new Error("choice questions need options (array or { label: description }).");
}

function normalizeScoreCriteria(spec: Record<string, unknown>): unknown[] {
  if (Array.isArray(spec.levels) && spec.levels.length >= 2) return spec.levels;
  if (Array.isArray(spec.criteria) && spec.criteria.length >= 2) return spec.criteria;
  throw new Error("score questions need at least two levels.");
}

/** Reset the cached SDK require — tests only. */
export function _resetTypeSafeSdkCache(): void {
  cachedSdk = undefined;
}
