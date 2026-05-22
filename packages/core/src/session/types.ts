import type { ChatMessage } from "../models/types.js";

export interface Session {
  sessionId: string;
  userId?: string;
  messages: ChatMessage[];
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
