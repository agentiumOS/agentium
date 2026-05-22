import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolDef } from "../../tools/types.js";
import type { Skill, SkillLoader, SkillManifest } from "../types.js";

export class LocalSkillLoader implements SkillLoader {
  canLoad(source: string): boolean {
    return source.startsWith("./") || source.startsWith("/") || source.startsWith("../");
  }

  async load(source: string): Promise<Skill> {
    const dir = resolve(source);
    const manifestPath = join(dir, "skill.json");

    let manifestText: string;
    try {
      manifestText = await readFile(manifestPath, "utf-8");
    } catch {
      throw new Error(`Cannot read skill manifest at ${manifestPath}`);
    }

    const manifest: SkillManifest = JSON.parse(manifestText);

    if (!manifest.name || !manifest.main) {
      throw new Error(`Invalid skill manifest at ${manifestPath}: name and main are required`);
    }

    const mainPath = join(dir, manifest.main);
    let mod: any;
    try {
      mod = await import(mainPath);
    } catch (e: any) {
      throw new Error(`Failed to load skill module at ${mainPath}: ${e.message}`);
    }

    const tools: ToolDef[] = [];
    if (typeof mod.getTools === "function") {
      tools.push(...mod.getTools());
    } else if (typeof mod.default === "function") {
      tools.push(...mod.default());
    } else if (Array.isArray(mod.tools)) {
      tools.push(...mod.tools);
    } else if (Array.isArray(mod.default)) {
      tools.push(...mod.default);
    }

    let instructions: string | undefined;
    if (manifest.instructions) {
      if (manifest.instructions.endsWith(".md") || manifest.instructions.endsWith(".txt")) {
        try {
          instructions = await readFile(join(dir, manifest.instructions), "utf-8");
        } catch {
          instructions = manifest.instructions;
        }
      } else {
        instructions = manifest.instructions;
      }
    }

    return {
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "0.0.0",
      tools,
      instructions,
      metadata: manifest.metadata,
    };
  }
}
