import type { ModelProvider } from "../models/provider.js";
import { getTextContent } from "../models/types.js";
import type { StorageDriver } from "../storage/driver.js";
import type { CulturalKnowledge } from "./types.js";

const NAMESPACE = "culture";

export interface CultureManagerConfig {
  storage: StorageDriver;
  model?: ModelProvider;
}

export class CultureManager {
  private storage: StorageDriver;
  private model: ModelProvider | null;

  constructor(config: CultureManagerConfig) {
    this.storage = config.storage;
    this.model = config.model ?? null;
  }

  async getAll(): Promise<CulturalKnowledge[]> {
    const items = await this.storage.list<CulturalKnowledge>(NAMESPACE);
    return items.map((item) => item.value);
  }

  async get(id: string): Promise<CulturalKnowledge | null> {
    return this.storage.get<CulturalKnowledge>(NAMESPACE, id);
  }

  async add(knowledge: CulturalKnowledge): Promise<void> {
    await this.storage.set(NAMESPACE, knowledge.id, knowledge);
  }

  async update(id: string, partial: Partial<CulturalKnowledge>): Promise<void> {
    const existing = await this.storage.get<CulturalKnowledge>(NAMESPACE, id);
    if (!existing) throw new Error(`Cultural knowledge "${id}" not found`);
    const updated = { ...existing, ...partial, updatedAt: Date.now() };
    await this.storage.set(NAMESPACE, id, updated);
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(NAMESPACE, id);
  }

  async buildContext(): Promise<string> {
    const all = await this.getAll();
    if (all.length === 0) return "";

    const sections = all.map((k) => {
      let section = `### ${k.name}`;
      if (k.categories?.length) section += ` [${k.categories.join(", ")}]`;
      section += `\n${k.content}`;
      if (k.notes) section += `\nNotes: ${k.notes}`;
      return section;
    });

    return `## Organizational Knowledge\n\n${sections.join("\n\n")}`;
  }

  async reflect(input: string, output: string): Promise<void> {
    if (!this.model) return;

    try {
      const response = await this.model.generate(
        [
          {
            role: "system",
            content: `You extract universal principles from agent interactions. Given this input/output pair, determine if there is a reusable insight, best practice, or lesson. If so, return a JSON object with fields: name (string), content (string), categories (string array). If no meaningful insight, return null.`,
          },
          {
            role: "user",
            content: `Input: ${input}\n\nOutput: ${output}`,
          },
        ],
        { maxTokens: 512, temperature: 0 },
      );

      const text = getTextContent(response.message.content);
      if (!text || text.trim() === "null") return;

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.name || !parsed.content) return;

      const knowledge: CulturalKnowledge = {
        id: `auto_${Date.now()}`,
        name: parsed.name,
        content: parsed.content,
        categories: parsed.categories ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await this.add(knowledge);
    } catch {
      // reflection is best-effort
    }
  }
}
