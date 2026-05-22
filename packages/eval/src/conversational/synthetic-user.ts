import type { ChatMessage, ModelProvider } from "@agentium/core";
import type { UserPersona } from "./types.js";

const SYSTEM_PROMPT = `You are simulating a user in a conversation with an AI assistant.

Your persona:
- Name: {name}
- Description: {description}
- Goal: {goal}

Rules:
1. Stay in character. Respond naturally as this person would.
2. Work toward your goal through the conversation.
3. If the assistant has fully satisfied your goal, respond with EXACTLY "GOAL_COMPLETE" (nothing else).
4. Keep responses concise and realistic (1-3 sentences typically).
5. You may ask follow-up questions, provide corrections, or change direction as a real user would.
6. Do NOT break character or mention that you are simulated.`;

export class SyntheticUser {
  private persona: UserPersona;
  private model: ModelProvider;

  constructor(persona: UserPersona, model: ModelProvider) {
    this.persona = persona;
    this.model = persona.model ?? model;
  }

  async generateMessage(conversationHistory: ChatMessage[]): Promise<{ message: string; goalComplete: boolean }> {
    const systemPrompt = SYSTEM_PROMPT.replace("{name}", this.persona.name)
      .replace("{description}", this.persona.description)
      .replace("{goal}", this.persona.goal);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((m) => ({
        role: (m.role === "user" ? "assistant" : "user") as "user" | "assistant",
        content: m.content,
      })),
    ];

    const response = await this.model.generate(messages);
    const text =
      typeof response.message.content === "string"
        ? response.message.content
        : (response.message.content
            ?.filter((p): p is { type: "text"; text: string } => (p as any).type === "text")
            .map((p) => p.text)
            .join("") ?? "");

    const trimmed = text.trim();

    if (trimmed === "GOAL_COMPLETE" || trimmed.includes("GOAL_COMPLETE")) {
      return { message: trimmed, goalComplete: true };
    }

    return { message: trimmed, goalComplete: false };
  }
}
