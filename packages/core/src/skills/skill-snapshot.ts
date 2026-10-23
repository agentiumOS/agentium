import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v3";

function isSkillFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return (
    Object.hasOwn(value, "SKILL.md") &&
    Object.entries(value).every(([path, text]) => isSkillReferencePath(path) && typeof text === "string")
  );
}
// Zod's record parser excludes __proto__; it can also be a valid on-disk filename.
const fileMap = z
  .custom<Record<string, string>>(isSkillFileMap, "Invalid skill files")
  .transform((value) => Object.fromEntries(Object.entries(value)));
const skillFiles = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    files: fileMap,
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    skills: z.array(skillFiles),
  })
  .strict();

/** Immutable text assets for one admitted run; contains no filesystem paths or credentials. */
export type SkillMdSnapshot = z.infer<typeof snapshotSchema>;
export interface SkillSnapshotLimits {
  /** Total encoded UTF-8 bytes of all skill files. Exceeding this fails without truncation. */
  maxBytes: number;
  maxFiles: number;
}

export function isSkillReferencePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function canonicalSkills(skills: SkillMdSnapshot["skills"]): SkillMdSnapshot["skills"] {
  return skills
    .map((skill) => ({
      name: skill.name,
      files: Object.fromEntries(Object.entries(skill.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function digestSkills(skills: SkillMdSnapshot["skills"]): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, skills: canonicalSkills(skills) }))
    .digest("hex");
}

async function readBoundedText(path: string, remainingBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Skill snapshot contains a non-regular file");
    if (info.size > remainingBytes) throw new Error("Skill snapshot byte limit exceeded");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65_536, remainingBytes - bytes + 1));
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > remainingBytes) throw new Error("Skill snapshot byte limit exceeded");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    // Match the text delivered by ordinary get_skill_reference, including UTF-8 decoding.
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Validate persisted text and content identity before supplying it to an Agent. */
export function parseSkillMdSnapshot(value: unknown): SkillMdSnapshot {
  const snapshot = snapshotSchema.parse(value);
  const names = new Set<string>();
  for (const skill of snapshot.skills) {
    if (names.has(skill.name)) throw new Error(`Duplicate skill name: ${skill.name}`);
    names.add(skill.name);
  }
  if (digestSkills(snapshot.skills) !== snapshot.digest) throw new Error("Skill snapshot digest mismatch");
  return { ...snapshot, skills: canonicalSkills(snapshot.skills) };
}

/** Capture every regular file under the selected skill folders. Links are rejected. */
export async function captureSkillMdSnapshot(
  skills: readonly { name: string; dir: string }[],
  limits: SkillSnapshotLimits,
  parseName: (source: string, fallbackName: string) => string,
): Promise<SkillMdSnapshot> {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes <= 0 ||
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles <= 0
  ) {
    throw new TypeError("Skill snapshot limits must be positive safe integers");
  }
  let bytes = 0;
  let count = 0;
  const captured: SkillMdSnapshot["skills"] = [];
  for (const skill of skills) {
    const files: Record<string, string> = {};
    const root = await lstat(skill.dir);
    if (root.isSymbolicLink()) throw new Error("Skill snapshot cannot contain symbolic links");
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!isSkillReferencePath(path)) throw new Error("Invalid skill snapshot file path");
        if (entry.isSymbolicLink()) throw new Error("Skill snapshot cannot contain symbolic links");
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute, path);
        else if (entry.isFile()) {
          if (++count > limits.maxFiles) throw new Error("Skill snapshot file limit exceeded");
          const content = await readBoundedText(absolute, limits.maxBytes - bytes);
          bytes += Buffer.byteLength(content);
          if (bytes > limits.maxBytes) throw new Error("Skill snapshot byte limit exceeded");
          Object.defineProperty(files, path, { value: content, enumerable: true, writable: true, configurable: true });
        } else throw new Error("Skill snapshot contains a non-regular file");
      }
    };
    await visit(skill.dir, "");
    captured.push({ name: parseName(files["SKILL.md"], skill.name), files });
  }
  return parseSkillMdSnapshot({ version: 1, skills: captured, digest: digestSkills(captured) });
}
