import type { PublicMessage } from "./public-messages.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Only documented display fields; reasoning.content and encrypted content are not summaries. */
export function responsesPublicMessages(response: unknown): PublicMessage[] {
  if (!object(response) || !Array.isArray(response.output)) return [];
  const toolCalls = response.output.some((item: unknown) => object(item) && item.type === "function_call");
  const messages: PublicMessage[] = [];
  for (const item of response.output) {
    if (!object(item)) continue;
    const id = typeof item.id === "string" ? item.id : "text";
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .flatMap((part: unknown) =>
          object(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("");
      if (text)
        messages.push({
          id,
          phase:
            item.phase === "commentary"
              ? "commentary"
              : item.phase === "final_answer"
                ? "final"
                : toolCalls
                  ? "commentary"
                  : "final",
          text,
        });
    } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
      const text = item.summary
        .flatMap((part: unknown) =>
          object(part) && part.type === "summary_text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("");
      if (text) messages.push({ id: `${id}:summary`, phase: "reasoning_summary", text });
    }
  }
  return messages;
}
