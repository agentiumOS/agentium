import { z } from "zod";
import type { ModelProvider } from "../../models/provider.js";
import type { ChatMessage } from "../../models/types.js";
import type { StorageDriver } from "../../storage/driver.js";
import type { ToolDef } from "../../tools/types.js";

const NS = "memory:user-profile";

export interface UserProfileData {
  name?: string;
  preferredName?: string;
  role?: string;
  company?: string;
  location?: string;
  timezone?: string;
  language?: string;
  custom: Record<string, unknown>;
  updatedAt: Date;
}

const EXTRACTION_PROMPT = `You are a profile extraction assistant. Analyze the conversation and extract structured user profile information.

Extract ONLY concrete profile data mentioned in the conversation. Do not infer or guess.

Return a JSON object with any of these fields (omit fields not mentioned):
{
  "name": "full name",
  "preferredName": "how they like to be addressed",
  "role": "job title or role",
  "company": "company or organization",
  "location": "city, country",
  "timezone": "IANA timezone like America/New_York",
  "language": "preferred language",
  "custom": { "key": "value" }
}

If no profile information is found, return {}.

Current profile:
{currentProfile}

Conversation:
{conversation}

Return ONLY a JSON object:`;

export class UserProfile {
  private storage: StorageDriver;
  private model?: ModelProvider;
  private customFields: string[];

  constructor(storage: StorageDriver, config?: { model?: ModelProvider; customFields?: string[] }) {
    this.storage = storage;
    this.model = config?.model;
    this.customFields = config?.customFields ?? [];
  }

  async getProfile(userId: string): Promise<UserProfileData | null> {
    return this.storage.get<UserProfileData>(NS, userId);
  }

  async updateProfile(userId: string, patch: Partial<UserProfileData>): Promise<UserProfileData> {
    const existing = (await this.getProfile(userId)) ?? {
      custom: {},
      updatedAt: new Date(),
    };

    const updated: UserProfileData = {
      ...existing,
      ...patch,
      custom: { ...existing.custom, ...patch.custom },
      updatedAt: new Date(),
    };

    await this.storage.set(NS, userId, updated);
    return updated;
  }

  async clear(userId: string): Promise<void> {
    await this.storage.delete(NS, userId);
  }

  async getContextString(userId: string): Promise<string> {
    const profile = await this.getProfile(userId);
    if (!profile) return "";

    const lines: string[] = [];
    if (profile.name) lines.push(`- Name: ${profile.name}`);
    if (profile.preferredName) lines.push(`- Preferred name: ${profile.preferredName}`);
    if (profile.role) lines.push(`- Role: ${profile.role}`);
    if (profile.company) lines.push(`- Company: ${profile.company}`);
    if (profile.location) lines.push(`- Location: ${profile.location}`);
    if (profile.timezone) lines.push(`- Timezone: ${profile.timezone}`);
    if (profile.language) lines.push(`- Language: ${profile.language}`);

    for (const [key, value] of Object.entries(profile.custom)) {
      if (value != null) lines.push(`- ${key}: ${value}`);
    }

    if (lines.length === 0) return "";
    return `About this user:\n${lines.join("\n")}`;
  }

  asTool(): ToolDef {
    return {
      name: "update_user_profile",
      description:
        "Update the current user's profile with structured information like name, role, company, location, timezone, or custom fields.",
      parameters: z.object({
        name: z.string().optional().describe("User's full name"),
        preferredName: z.string().optional().describe("How the user likes to be addressed"),
        role: z.string().optional().describe("Job title or role"),
        company: z.string().optional().describe("Company or organization"),
        location: z.string().optional().describe("City, country"),
        timezone: z.string().optional().describe("IANA timezone"),
        language: z.string().optional().describe("Preferred language"),
        custom: z.record(z.unknown()).optional().describe("Additional custom fields"),
      }),
      execute: async (args, ctx) => {
        const uid = ctx.userId;
        if (!uid) return "No user identified for this session.";
        const updated = await this.updateProfile(uid, args as Partial<UserProfileData>);
        return `Profile updated: ${JSON.stringify(updated, null, 2)}`;
      },
    };
  }

  async extractAndUpdate(userId: string, messages: ChatMessage[], fallbackModel?: ModelProvider): Promise<void> {
    const model = this.model ?? fallbackModel;
    if (!model) return;

    try {
      const current = await this.getProfile(userId);
      const currentStr = current ? JSON.stringify(current, null, 2) : "{}";

      const conversationStr = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = typeof m.content === "string" ? m.content : "(multimodal)";
          return `${m.role}: ${content}`;
        })
        .join("\n");

      const prompt = EXTRACTION_PROMPT.replace("{currentProfile}", currentStr).replace(
        "{conversation}",
        conversationStr,
      );

      const response = await model.generate([{ role: "user", content: prompt }], {
        temperature: 0,
        maxTokens: 500,
      });

      const text = typeof response.message.content === "string" ? response.message.content : "";
      if (!text) return;

      const KNOWN_PROFILE_KEYS = new Set([
        "name",
        "preferredName",
        "role",
        "company",
        "location",
        "timezone",
        "language",
        "occupation",
        "interests",
        "preferences",
        "communicationStyle",
        "expertise",
        "goals",
        "custom",
      ]);

      const jsonStr = extractJsonObject(text);
      const parsed = JSON.parse(jsonStr);

      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (KNOWN_PROFILE_KEYS.has(key)) {
            filtered[key] = value;
          }
        }
        if (Object.keys(filtered).length > 0) {
          await this.updateProfile(userId, filtered);
        }
      }
    } catch (err) {
      console.warn("[UserProfile] extractAndUpdate failed:", (err as Error).message ?? err);
    }
  }
}

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return text.trim();
}
