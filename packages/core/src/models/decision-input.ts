import { z } from "zod";
import {
  type DecisionInputItem,
  type DecisionInputPart,
  type DecisionQuestion,
  decisionInputItemSchema,
  validateDecisionJSON,
} from "./decisions.js";
import type { ChatMessage, MessageContent } from "./types.js";

function inputParts(content: MessageContent | null): Array<Exclude<DecisionInputPart, { type: "input_json" }>> {
  if (content === null) return [];
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.type !== "image") throw new Error(`OpenAI Decisions does not support ${part.type} input`);
    return {
      type: "input_image",
      image_url: /^(https?:|data:)/i.test(part.data)
        ? part.data
        : `data:${part.mimeType ?? "image/png"};base64,${part.data}`,
    };
  });
}

export function buildDecisionInput(messages: ChatMessage[]): DecisionInputItem[] {
  const input: DecisionInputItem[] = [];
  for (const message of messages) {
    const content = inputParts(message.content);
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("OpenAI Decisions tool results require a matching tool call ID");
      if (message.toolCalls?.length) throw new Error("OpenAI Decisions tool results cannot contain tool calls");
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: content });
      continue;
    }
    if (message.toolCalls?.length && message.role !== "assistant")
      throw new Error("OpenAI Decisions tool calls must belong to assistant messages");
    if (content.length) {
      if (message.role === "user") input.push({ role: "user", content });
      else {
        const text = content.map((part) => {
          if (part.type !== "input_text")
            throw new Error(`OpenAI Decisions ${message.role} messages support text only`);
          return part.text;
        });
        if (message.role === "assistant") {
          input.push({
            role: "assistant",
            content: text.map((value) => ({ type: "output_text", text: value })),
            ...(message.phase ? { phase: message.phase === "final" ? "final_answer" : "commentary" } : {}),
          });
        } else input.push({ role: "system", content: text.map((value) => ({ type: "input_text", text: value })) });
      }
    }
    for (const call of message.toolCalls ?? []) {
      validateDecisionJSON(call.arguments, false);
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return input;
}

export function validateDecisionInput(input: unknown, questions: DecisionQuestion[]): DecisionInputItem[] {
  const parsed = z.array(decisionInputItemSchema).min(1).safeParse(input);
  if (!parsed.success) throw new Error(`Invalid OpenAI Decisions input: ${parsed.error.message}`);
  let images = 0;
  const calls = new Map<string, { type: "function_call" | "custom_tool_call"; consumed: boolean }>();
  for (const item of parsed.data) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (calls.has(item.call_id)) throw new Error(`Duplicate Decisions tool call ID: ${item.call_id}`);
      calls.set(item.call_id, { type: item.type, consumed: false });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const call = calls.get(item.call_id);
      if (!call || call.consumed || item.type !== `${call.type}_output`)
        throw new Error(`Decisions tool output must match one preceding call of the same kind: ${item.call_id}`);
      call.consumed = true;
    }
    const parts = "content" in item ? item.content : "output" in item ? item.output : [];
    if (Array.isArray(parts)) images += parts.filter((part) => part.type === "input_image").length;
  }
  for (const question of questions)
    if (Array.isArray(question.instructions))
      images += question.instructions.filter((part) => part.type === "input_image").length;
  if (images > 128) throw new Error("OpenAI Decisions accepts at most 128 images across input and questions");
  return parsed.data;
}
