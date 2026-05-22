import type { ToolDef } from "../tools/types.js";
import { LocalSkillLoader } from "./loaders/local.js";
import { NpmSkillLoader } from "./loaders/npm.js";
import { RemoteSkillLoader } from "./loaders/remote.js";
import type { Skill, SkillLoader, SkillSource } from "./types.js";

/**
 * Orchestrates skill loading from multiple sources.
 * Skills are loaded lazily on first access.
 */
export class SkillManager {
  private loaders: SkillLoader[];
  private sources: Array<Skill | SkillSource>;
  private loaded: Skill[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(sources: Array<Skill | SkillSource>) {
    this.sources = sources;
    this.loaders = [new LocalSkillLoader(), new RemoteSkillLoader(), new NpmSkillLoader()];
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doLoad();
    }
    await this.initPromise;
  }

  private async doLoad(): Promise<void> {
    for (const source of this.sources) {
      try {
        if (typeof source === "string") {
          const skill = await this.loadFromSource(source);
          this.loaded.push(skill);
        } else {
          this.loaded.push(source);
        }
      } catch (err) {
        console.warn(`[agentium] Failed to load skill: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async loadFromSource(source: string): Promise<Skill> {
    for (const loader of this.loaders) {
      if (loader.canLoad(source)) {
        return loader.load(source);
      }
    }
    throw new Error(`No loader found for skill source: "${source}"`);
  }

  /** Get all tools from all loaded skills. Triggers lazy loading. */
  async getTools(): Promise<ToolDef[]> {
    await this.ensureLoaded();
    const tools: ToolDef[] = [];
    for (const skill of this.loaded) {
      tools.push(...skill.tools);
    }
    return tools;
  }

  /** Get combined instruction fragments from all loaded skills. */
  async getInstructions(): Promise<string> {
    await this.ensureLoaded();
    const parts: string[] = [];
    for (const skill of this.loaded) {
      if (skill.instructions) {
        parts.push(`[Skill: ${skill.name}]\n${skill.instructions}`);
      }
    }
    return parts.join("\n\n");
  }

  /** Get all loaded skills. Triggers lazy loading. */
  async getSkills(): Promise<Skill[]> {
    await this.ensureLoaded();
    return [...this.loaded];
  }

  /** Add a skill or source dynamically after construction. */
  async addSkill(source: Skill | SkillSource): Promise<Skill> {
    await this.ensureLoaded();
    if (typeof source === "string") {
      const skill = await this.loadFromSource(source);
      this.loaded.push(skill);
      return skill;
    }
    this.loaded.push(source);
    return source;
  }
}

/** Convenience function — loads a skill from any source type. */
export async function loadSkill(source: SkillSource): Promise<Skill> {
  const manager = new SkillManager([source]);
  const skills = await manager.getSkills();
  return skills[0];
}
