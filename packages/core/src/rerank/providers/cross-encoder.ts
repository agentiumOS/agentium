import type { CrossEncoderPipeline, CrossEncoderRerankerConfig } from "./cross-encoder-reranker.js";

type LoadOptions = Parameters<NonNullable<CrossEncoderRerankerConfig["pipelineFactory"]>>[2];
type Tokenizer = (text: string, options: { text_pair: string; padding: true; truncation: true }) => unknown;
type Classifier = ((inputs: unknown) => Promise<{ logits: { dims: readonly number[]; data: ArrayLike<number> } }>) & {
  config: { id2label?: Record<string, string> };
};

/** Structural boundary for the optional SDK; does not load model weights itself. */
export interface CrossEncoderSDK {
  AutoTokenizer: { from_pretrained: (model: string, options: LoadOptions) => Promise<Tokenizer> };
  AutoModelForSequenceClassification: { from_pretrained: (model: string, options: LoadOptions) => Promise<Classifier> };
}

/** Transformers.js text-classification does not accept Python-style pair objects,
 * and its default softmax maps a single relevance logit to the constant 1.
 * Tokenize the pair explicitly and normalize the raw relevance logits instead. */
export async function loadCrossEncoder(
  sdk: CrossEncoderSDK,
  modelId: string,
  options: LoadOptions,
): Promise<CrossEncoderPipeline> {
  const tokenizer = await sdk.AutoTokenizer.from_pretrained(modelId, options);
  const model = await sdk.AutoModelForSequenceClassification.from_pretrained(modelId, options);
  return async ({ text, text_pair }) => {
    const inputs = await tokenizer(text, { text_pair, padding: true, truncation: true });
    const { logits } = await model(inputs);
    if (logits.dims.length !== 2 || logits.dims[0] !== 1 || logits.dims[1] < 1 || logits.dims[1] !== logits.data.length)
      throw new Error("Cross-encoder requires one sequence classification result");
    return Array.from(logits.data, (value, index) => {
      if (!Number.isFinite(value)) throw new Error("Cross-encoder returned a nonfinite relevance logit");
      return { label: model.config.id2label?.[index] ?? `LABEL_${index}`, score: 1 / (1 + Math.exp(-value)) };
    });
  };
}
