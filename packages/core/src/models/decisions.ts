import { z } from "zod";

const choiceValue = z.union([z.string(), z.boolean()]);
const probability = z.number().finite().min(0).max(1);
const imageURL = z.string().refine((value) => {
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, "Images require an HTTP(S) URL or a supported base64 image data URL");
const textFields = { type: z.literal("input_text"), text: z.string() };
const imageFields = {
  type: z.literal("input_image"),
  image_url: imageURL,
  detail: z.enum(["low", "high", "auto", "original"]).nullish(),
};
const instructionPartSchema = z.discriminatedUnion("type", [
  z.object(textFields).strict(),
  z.object(imageFields).strict(),
]);

/** Text or image instructions for one question. */
export type DecisionInstructionPart = z.infer<typeof instructionPartSchema>;

/** A finite JSON value. Undefined, non-finite numbers and class instances are rejected. */
export type DecisionJSONValue =
  | string
  | number
  | boolean
  | null
  | DecisionJSONValue[]
  | { [key: string]: DecisionJSONValue };
type DecisionJSONData = { [key: string]: DecisionJSONValue } | Array<{ [key: string]: DecisionJSONValue }>;

export function validateDecisionJSON(value: unknown, bounded = true): void {
  const ancestors = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (bounded && ++count > 10_000) throw new Error("Decision JSON supports at most 10,000 values");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") throw new Error("Decision JSON must contain only finite JSON values");
    if (bounded && depth > 32) throw new Error("Decision JSON supports at most 32 container levels");
    if (ancestors.has(item)) throw new Error("Decision JSON cannot contain circular values");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1)
        throw new Error("Decision JSON arrays cannot contain holes or additional properties");
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor?.enumerable || !("value" in descriptor))
          throw new Error("Decision JSON arrays must contain plain JSON values");
        visit(descriptor.value, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("Decision JSON must contain plain objects");
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor))
          throw new Error("Decision JSON must contain plain JSON properties");
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 1);
  if (bounded && new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024)
    throw new Error("Decision JSON supports at most 256 KiB of compact UTF-8 JSON");
}

const jsonDataSchema = z.custom<DecisionJSONData>().superRefine((value, context) => {
  try {
    validateDecisionJSON(value);
    if (
      value === null ||
      typeof value !== "object" ||
      (Array.isArray(value) && value.some((item) => item === null || typeof item !== "object" || Array.isArray(item)))
    )
      throw new Error("Decision JSON data must be an object or an array of objects");
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid Decision JSON" });
  }
});
const breakpoint = z
  .object({ mode: z.literal("explicit") })
  .strict()
  .nullish();
const textSchema = z.object({ ...textFields, prompt_cache_breakpoint: breakpoint }).strict();
const imageSchema = z.object({ ...imageFields, prompt_cache_breakpoint: breakpoint }).strict();
const sharedPartSchema = z.discriminatedUnion("type", [textSchema, imageSchema]);
const inputPartSchema = z.discriminatedUnion("type", [
  textSchema,
  imageSchema,
  z.object({ type: z.literal("input_json"), data: jsonDataSchema }).strict(),
]);

/** Native user evidence. Cache breakpoints apply only to shared text and images. */
export type DecisionInputPart = z.infer<typeof inputPartSchema>;

const messageType = z.literal("message").optional();
const callFields = {
  call_id: z.string().min(1).max(64),
  id: z.string().max(1_048_576).nullish(),
  status: z.enum(["in_progress", "completed", "incomplete"]).nullish(),
};
const outputFields = { ...callFields, output: z.union([z.string(), z.array(sharedPartSchema)]) };
export const decisionInputItemSchema = z.union([
  z
    .object({ type: messageType, role: z.literal("user"), content: z.union([z.string(), z.array(inputPartSchema)]) })
    .strict(),
  z
    .object({
      type: messageType,
      role: z.enum(["system", "developer"]),
      content: z.union([z.string(), z.array(textSchema)]),
    })
    .strict(),
  z
    .object({
      type: messageType,
      role: z.literal("assistant"),
      content: z.union([
        z.string(),
        z.array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("output_text"), text: z.string() }).strict(),
            z.object({ type: z.literal("refusal"), refusal: z.string() }).strict(),
          ]),
        ),
      ]),
      phase: z.enum(["commentary", "final_answer"]).nullish(),
    })
    .strict(),
  z
    .object({
      ...callFields,
      type: z.literal("function_call"),
      name: z.string().min(1).max(128),
      arguments: z.string().max(1_048_576),
      namespace: z.string().min(1).max(64).nullish(),
    })
    .strict(),
  z
    .object({
      ...callFields,
      type: z.literal("custom_tool_call"),
      name: z.string().min(1).max(64),
      input: z.string().max(1_048_576),
      namespace: z.string().min(1).max(64).nullish(),
    })
    .strict(),
  z.object({ ...outputFields, type: z.literal("function_call_output") }).strict(),
  z.object({ ...outputFields, type: z.literal("custom_tool_call_output") }).strict(),
]);

/** Ordered messages and historical tool activity evaluated as evidence, never executed. */
export type DecisionInputItem = z.infer<typeof decisionInputItemSchema>;

const questionBase = {
  name: z.string().optional(),
  instructions: z.union([z.string().min(1), z.array(instructionPartSchema).min(1)]),
};

const questionSchema = z.discriminatedUnion("type", [
  z.object({ ...questionBase, type: z.literal("predicate") }).strict(),
  z
    .object({
      ...questionBase,
      type: z.literal("choice"),
      choices: z.array(z.object({ value: choiceValue, description: z.string().optional() }).strict()).min(1),
    })
    .strict(),
  z
    .object({
      ...questionBase,
      type: z.literal("score"),
      levels: z.array(z.object({ label: z.string(), description: z.string().optional() }).strict()).min(1),
    })
    .strict(),
]);

/** Native OpenAI Decisions question. Scores use zero-based level indices. */
export type DecisionQuestion = z.infer<typeof questionSchema>;

const answerBase = { name: z.string().nullable() };
const answerSchema: z.ZodType<DecisionAnswer> = z.discriminatedUnion("type", [
  z.object({ ...answerBase, type: z.literal("predicate"), probability }),
  z.object({
    ...answerBase,
    type: z.literal("choice"),
    choice: choiceValue,
    confidence: probability,
    probabilities: z.array(z.object({ value: choiceValue, probability })),
  }),
  z.object({
    ...answerBase,
    type: z.literal("score"),
    score: z.number().finite().nonnegative(),
    confidence: probability,
    probabilities: z.array(z.object({ value: z.number().int().nonnegative(), label: z.string(), probability })),
  }),
  z.object({ ...answerBase, type: z.literal("refusal") }),
]);

/** A validated Decisions answer, including a possible refusal for each question. */
export type DecisionAnswer = { name: string | null } & (
  | { type: "predicate"; probability: number }
  | {
      type: "choice";
      choice: string | boolean;
      confidence: number;
      probabilities: Array<{ value: string | boolean; probability: number }>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Array<{ value: number; label: string; probability: number }>;
    }
  | { type: "refusal" }
);

/** Jev uses a named map; OpenAI Decisions uses an ordered question array. */
export type ModelQuestions = Record<string, unknown> | DecisionQuestion[];

const tokens = z.number().int().nonnegative();
const responseSchema = z.object({
  model: z.string(),
  answers: z.array(answerSchema),
  usage: z
    .object({
      input_tokens: tokens,
      output_tokens: tokens,
      total_tokens: tokens,
      input_tokens_details: z.object({ cached_tokens: tokens, cache_write_tokens: tokens }),
      output_tokens_details: z.object({ reasoning_tokens: tokens }),
    })
    .passthrough(),
});

export function parseDecisionQuestions(value: unknown): DecisionQuestion[] {
  const parsed = z.array(questionSchema).min(1).max(400).safeParse(value);
  if (!parsed.success) throw new Error(`Invalid OpenAI Decisions questions: ${parsed.error.message}`);
  const names = new Set<string>();
  for (const question of parsed.data) {
    if (question.name !== undefined) {
      if (names.has(question.name)) throw new Error(`Duplicate decision question name: ${question.name}`);
      names.add(question.name);
    }
    if (
      question.type === "choice" &&
      new Set(question.choices.map((item) => item.value)).size !== question.choices.length
    )
      throw new Error("Decision choices must have distinct values");
  }
  return parsed.data;
}

export function parseDecisionResponse(value: unknown, questions: DecisionQuestion[]) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid OpenAI Decisions response: ${parsed.error.message}`);
  const response = parsed.data;
  if (response.answers.length !== questions.length) throw new Error("Decisions response has an incorrect answer count");
  for (const [index, answer] of response.answers.entries()) {
    const question = questions[index];
    if (!question || answer.name !== (question.name ?? null))
      throw new Error("Decisions response has a mismatched question name");
    if (answer.type === "refusal") continue;
    if (answer.type !== question.type) throw new Error("Decisions response has a mismatched answer type");
    if (answer.type === "choice" && question.type === "choice") {
      const allowed = new Set(question.choices.map((item) => item.value));
      if (
        !allowed.has(answer.choice) ||
        answer.probabilities.length !== allowed.size ||
        new Set(answer.probabilities.map((item) => item.value)).size !== allowed.size ||
        answer.probabilities.some((item) => !allowed.has(item.value))
      )
        throw new Error("Decisions response contains invalid choice values");
    }
    if (answer.type === "score" && question.type === "score") {
      if (
        answer.score > question.levels.length - 1 ||
        answer.probabilities.length !== question.levels.length ||
        new Set(answer.probabilities.map((item) => item.value)).size !== question.levels.length ||
        answer.probabilities.some((item) => question.levels[item.value]?.label !== item.label)
      )
        throw new Error("Decisions response contains invalid score levels");
    }
  }
  return response;
}
