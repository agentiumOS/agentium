import { createRequire } from "node:module";
import type { ToolDef } from "../../tools/types.js";
import type { Skill, SkillLoader } from "../types.js";

const require = createRequire(import.meta.url);

export class NpmSkillLoader implements SkillLoader {
  canLoad(source: string): boolean {
    if (source.startsWith("./") || source.startsWith("/") || source.startsWith("../")) return false;
    if (source.startsWith("http://") || source.startsWith("https://")) return false;
    return true;
  }

  async load(source: string): Promise<Skill> {
    let mod: any;
    try {
      mod = await import(source);
    } catch {
      try {
        mod = require(source);
      } catch (e: any) {
        throw new Error(`Failed to load npm skill "${source}": ${e.message}`);
      }
    }

    const tools: ToolDef[] = [];
    if (typeof mod.getTools === "function") {
      tools.push(...mod.getTools());
    } else if (typeof mod.default?.getTools === "function") {
      tools.push(...mod.default.getTools());
    } else if (Array.isArray(mod.tools)) {
      tools.push(...mod.tools);
    } else if (Array.isArray(mod.default?.tools)) {
      tools.push(...mod.default.tools);
    } else if (Array.isArray(mod.default)) {
      tools.push(...mod.default);
    }

    const name = mod.name ?? mod.default?.name ?? source;
    const description = mod.description ?? mod.default?.description ?? "";
    const version = mod.version ?? mod.default?.version ?? "0.0.0";
    const instructions = mod.instructions ?? mod.default?.instructions;

    return {
      name,
      description,
      version,
      tools,
      instructions,
      metadata: { source },
    };
  }
}
