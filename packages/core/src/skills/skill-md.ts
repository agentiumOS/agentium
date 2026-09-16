import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";

export interface SkillMd {
  name: string;
  description: string;
  body: string;
  dir: string;
  version?: string;
}

export interface SkillMdManagerConfig {
  /** Directories to scan for skill folders that contain SKILL.md */
  dirs: string[];
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Loads Agent Skills (`SKILL.md`) with progressive disclosure:
 * the prompt only gets name + description until the agent asks for the body.
 */
export class SkillMdManager {
  private skills: SkillMd[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(private config: SkillMdManagerConfig) {}

  async ensureLoaded(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.scan();
    await this.initPromise;
  }

  async list(): Promise<Array<Pick<SkillMd, "name" | "description">>> {
    await this.ensureLoaded();
    return this.skills.map(({ name, description }) => ({ name, description }));
  }

  async get(name: string): Promise<SkillMd | null> {
    await this.ensureLoaded();
    return this.skills.find((s) => s.name === name) ?? null;
  }

  /** ~100-token index injected into the system prompt. */
  async getIndexPrompt(): Promise<string> {
    const listed = await this.list();
    if (listed.length === 0) return "";
    const lines = listed.map((s) => `- ${s.name}: ${s.description}`);
    return `Available skills (load with get_skill_instructions when needed):\n${lines.join("\n")}`;
  }

  getTools(): ToolDef[] {
    return [
      defineTool({
        name: "list_skills",
        description: "List installed skills (name + description).",
        parameters: z.object({}),
        execute: async () => {
          const listed = await this.list();
          if (listed.length === 0) return "No skills installed.";
          return listed.map((s) => `${s.name}: ${s.description}`).join("\n");
        },
      }),
      defineTool({
        name: "get_skill_instructions",
        description: "Load the full SKILL.md instructions for a skill.",
        parameters: z.object({
          name: z.string().describe("Skill name"),
        }),
        execute: async ({ name }) => {
          const skill = await this.get(name);
          if (!skill) return `Skill "${name}" not found.`;
          return skill.body;
        },
      }),
      defineTool({
        name: "get_skill_reference",
        description: "Read a supporting file from a skill (references/, scripts/, assets/).",
        parameters: z.object({
          name: z.string().describe("Skill name"),
          path: z.string().describe("Relative path inside the skill folder, e.g. references/guide.md"),
        }),
        execute: async ({ name, path }) => {
          const skill = await this.get(name);
          if (!skill) return `Skill "${name}" not found.`;
          if (path.includes("..") || path.startsWith("/") || path.includes("\0")) {
            return "Invalid path.";
          }
          const full = join(skill.dir, path);
          if (!full.startsWith(skill.dir)) return "Invalid path.";
          try {
            return await readFile(full, "utf8");
          } catch {
            return `File not found: ${path}`;
          }
        },
      }),
    ];
  }

  private async scan(): Promise<void> {
    const found: SkillMd[] = [];
    for (const dir of this.config.dirs) {
      const root = resolve(dir);
      if (!existsSync(root)) continue;
      collectSkillDirs(root, found);
    }
    this.skills = found;
  }
}

function collectSkillDirs(root: string, out: SkillMd[], depth = 0): void {
  if (depth > 4) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  if (entries.includes("SKILL.md")) {
    const parsed = parseSkillMdSync(join(root, "SKILL.md"));
    if (parsed) out.push({ ...parsed, dir: root });
    return;
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    try {
      if (statSync(full).isDirectory()) collectSkillDirs(full, out, depth + 1);
    } catch {
      // skip
    }
  }
}

export function parseSkillMd(text: string, fallbackName?: string): Omit<SkillMd, "dir"> | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    if (!fallbackName) return null;
    return { name: fallbackName, description: "", body: text.trim() };
  }
  const front = match[1];
  const body = match[2].trim();
  const name = readYamlString(front, "name") ?? fallbackName;
  const description = readYamlString(front, "description") ?? "";
  const version = readYamlString(front, "version");
  if (!name || !NAME_RE.test(name) || name.length > 64) return null;
  if (description.length > 1024) return null;
  return { name, description, body, version };
}

function parseSkillMdSync(filePath: string): Omit<SkillMd, "dir"> | null {
  try {
    const text = readFileSync(filePath, "utf8");
    const fallback = basename(dirname(filePath));
    return parseSkillMd(text, fallback);
  } catch {
    return null;
  }
}

function readYamlString(front: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = front.match(re);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
}
