import type { ToolDef } from "../../tools/types.js";
import type { Skill, SkillLoader, SkillManifest } from "../types.js";

export class RemoteSkillLoader implements SkillLoader {
  canLoad(source: string): boolean {
    return source.startsWith("http://") || source.startsWith("https://");
  }

  async load(source: string): Promise<Skill> {
    if (typeof source === "string") {
      const url = new URL(source);
      const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (!isLocal && url.protocol !== "https:") {
        throw new Error(`Remote skills must use HTTPS. Got: ${url.protocol}//${url.hostname}`);
      }
    }

    const manifestUrl = source.endsWith("/skill.json") ? source : `${source}/skill.json`;

    let manifestText: string;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifestText = await res.text();
    } catch (e: any) {
      throw new Error(`Failed to fetch skill manifest from ${manifestUrl}: ${e.message}`);
    }

    const manifest: SkillManifest = JSON.parse(manifestText);

    if (!manifest.name || !manifest.main) {
      throw new Error(`Invalid remote skill manifest at ${manifestUrl}: name and main are required`);
    }

    const baseUrl = source.endsWith("/skill.json") ? source.replace(/\/skill\.json$/, "") : source;
    const mainUrl = `${baseUrl}/${manifest.main}`;

    console.warn(`[agentium] Loading remote skill from ${mainUrl} — ensure you trust this source`);

    let mod: any;
    try {
      mod = await import(/* webpackIgnore: true */ mainUrl);
    } catch (e: any) {
      throw new Error(`Failed to import remote skill module from ${mainUrl}: ${e.message}`);
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
    if (manifest.instructions && !manifest.instructions.endsWith(".md") && !manifest.instructions.endsWith(".txt")) {
      instructions = manifest.instructions;
    } else if (manifest.instructions) {
      try {
        const res = await fetch(`${baseUrl}/${manifest.instructions}`);
        if (res.ok) instructions = await res.text();
      } catch {
        // ignore
      }
    }

    return {
      name: manifest.name,
      description: manifest.description ?? "",
      version: manifest.version ?? "0.0.0",
      tools,
      instructions,
      metadata: { ...manifest.metadata, source },
    };
  }
}
