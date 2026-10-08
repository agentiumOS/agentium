import { z } from "zod";

const choiceValue = z.union([z.string(), z.boolean()]);
const probability = z.number().finite().min(0).max(1);
const questionBase = { name: z.string().optional(), instructions: z.string().min(1) };

const questionSchema: z.ZodType<DecisionQuestion> = z.discriminatedUnion("type", [
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
export type DecisionQuestion = { name?: string; instructions: string } & (
  | { type: "predicate" }
  | { type: "choice"; choices: Array<{ value: string | boolean; description?: string }> }
  | { type: "score"; levels: Array<{ label: string; description?: string }> }
);

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
  const parsed = z.array(questionSchema).min(1).safeParse(value);
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
