import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod/v3";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";
import {
  captureSkillMdSnapshot,
  isSkillReferencePath,
  parseSkillMdSnapshot,
  type SkillMdSnapshot,
  type SkillSnapshotLimits,
} from "./skill-snapshot.js";

export interface SkillMd {
  name: string;
  description: string;
  body: string;
  dir: string;
  version?: string;
}

export interface SkillMdManagerConfig {
  /** Directories to scan for skill folders that contain SKILL.md */
  dirs?: string[];
  /** A validated, content-pinned catalog instead of live filesystem lookup. */
  snapshot?: unknown;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Loads Agent Skills (`SKILL.md`) with progressive disclosure:
 * the prompt only gets name + description until the agent asks for the body.
 */
export class SkillMdManager {
  private skills: SkillMd[] = [];
  private initPromise: Promise<void> | null = null;
  private pinned: SkillMdSnapshot | undefined;

  constructor(private config: SkillMdManagerConfig) {
    if (config.snapshot !== undefined) {
      if (config.dirs?.length) throw new Error("Configure either skill directories or a snapshot");
      this.pinned = parseSkillMdSnapshot(config.snapshot);
      this.skills = this.pinned.skills.map((skill) => {
        const parsed = parseSkillMd(skill.files["SKILL.md"], skill.name);
        if (!parsed || parsed.name !== skill.name) throw new Error("Invalid pinned skill metadata");
        return { ...parsed, dir: "" };
      });
      this.initPromise = Promise.resolve();
    }
  }

  /** Capture a portable catalog at admission. Store it with the run before dispatch. */
  async createSnapshot(limits: SkillSnapshotLimits): Promise<SkillMdSnapshot> {
    if (this.pinned) {
      let bytes = 0;
      let count = 0;
      for (const skill of this.pinned.skills) {
        for (const content of Object.values(skill.files)) {
          count++;
          bytes += Buffer.byteLength(content);
        }
      }
      if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 || bytes > limits.maxBytes)
        throw new Error("Skill snapshot byte limit exceeded");
      if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0 || count > limits.maxFiles)
        throw new Error("Skill snapshot file limit exceeded");
      return parseSkillMdSnapshot(this.pinned);
    }
    const locations: { name: string; dir: string }[] = [];
    for (const dir of this.config.dirs ?? []) {
      if (existsSync(dir)) collectSnapshotLocations(resolve(dir), locations, limits.maxFiles);
    }
    const snapshot = await captureSkillMdSnapshot(locations, limits, (source, fallback) => {
      const parsed = parseSkillMd(source, fallback);
      if (!parsed) throw new Error("Invalid skill metadata in snapshot");
      return parsed.name;
    });
    new SkillMdManager({ snapshot });
    return snapshot;
  }

  async readReference(name: string, path: string): Promise<string> {
    const skill = await this.get(name);
    if (!skill) return `Skill "${name}" not found.`;
    if (!isSkillReferencePath(path)) return "Invalid path.";
    if (this.pinned) {
      const files = this.pinned.skills.find((entry) => entry.name === name)?.files;
      return files && Object.hasOwn(files, path) ? files[path] : `File not found: ${path}`;
    }
    try {
      return await readFile(join(skill.dir, path), "utf8");
    } catch {
      return `File not found: ${path}`;
    }
  }

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
    const skill = this.skills.find((s) => s.name === name);
    return skill ? { ...skill } : null;
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
          return this.readReference(name, path);
        },
      }),
    ];
  }

  private async scan(): Promise<void> {
    const found: SkillMd[] = [];
    for (const dir of this.config.dirs ?? []) {
      const root = resolve(dir);
      if (!existsSync(root)) continue;
      collectSkillDirs(root, found);
    }
    this.skills = found;
  }
}

// Discover without reading SKILL.md: snapshot byte limits must apply before any text is loaded.
function collectSnapshotLocations(
  root: string,
  out: { name: string; dir: string }[],
  maxFiles: number,
  depth = 0,
): void {
  if (depth > 4) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error("Skill snapshot cannot contain symbolic links");
  const entries = readdirSync(root).sort();
  if (entries.includes("SKILL.md")) {
    if (out.length >= maxFiles) throw new Error("Skill snapshot file limit exceeded");
    out.push({ name: basename(root), dir: root });
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    const entry = lstatSync(full);
    if (entry.isSymbolicLink()) throw new Error("Skill snapshot cannot contain symbolic links");
    if (entry.isDirectory()) collectSnapshotLocations(full, out, maxFiles, depth + 1);
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
