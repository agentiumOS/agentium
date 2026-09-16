import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ContextFile {
  name: string;
  path: string;
  content: string;
  blocked?: string;
}

export interface LoadContextFilesOptions {
  /** Working directory to start from. Default: process.cwd() */
  cwd?: string;
  /** Max characters kept per file. Default: 20000 */
  maxChars?: number;
  /** Skip the prompt-injection scan. Default: false */
  skipScan?: boolean;
}

const PROJECT_FILES = [".agentium.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"] as const;

const THREAT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "prompt_injection", re: /ignore (all |any )?(previous|prior|above) instructions/i },
  { name: "prompt_injection", re: /disregard (your|all) (rules|instructions)/i },
  { name: "deception", re: /do not tell the user/i },
  { name: "system_override", re: /system prompt override/i },
  { name: "hidden_html", re: /<!--[\s\S]{0,200}(ignore|secret|exfil)/i },
  { name: "exfil", re: /curl[^\n]{0,200}\$(API_KEY|TOKEN|SECRET)/i },
  { name: "secret_file", re: /\bcat\s+(\.env|credentials)\b/i },
  { name: "invisible", re: /(\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202E)/ },
];

/**
 * Load project instruction files (AGENTS.md and friends).
 *
 * Walks from `cwd` up to the git root and merges matching files.
 * Only one project-file type is used (first match in PROJECT_FILES order).
 */
export async function loadContextFiles(opts: LoadContextFilesOptions = {}): Promise<ContextFile[]> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const maxChars = opts.maxChars ?? 20_000;
  const loaded: ContextFile[] = [];

  const chain = contextFileChain(cwd);
  let chosenType: string | null = null;

  for (const dir of chain) {
    for (const name of PROJECT_FILES) {
      if (chosenType && name !== chosenType) continue;
      const filePath = join(dir, name);
      if (!existsSync(filePath)) continue;
      chosenType = name;
      const file = await readOne(filePath, name, maxChars, opts.skipScan);
      if (file) loaded.push(file);
      break;
    }
  }

  return loaded;
}

export function formatContextFiles(files: ContextFile[]): string {
  if (files.length === 0) return "";
  const parts = files.map((f) => {
    if (f.blocked) {
      return `## ${f.name}\n[BLOCKED: ${f.blocked}. Content not loaded.]`;
    }
    return `## ${f.name}\n${f.content}`;
  });
  return `# Project Context\n\nThe following project files were loaded. Follow them.\n\n${parts.join("\n\n")}`;
}

function contextFileChain(cwd: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  for (let i = 0; i < 32; i++) {
    dirs.push(current);
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

async function readOne(
  filePath: string,
  name: string,
  maxChars: number,
  skipScan?: boolean,
): Promise<ContextFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  if (!skipScan) {
    for (const threat of THREAT_PATTERNS) {
      if (threat.re.test(raw)) {
        return { name, path: filePath, content: "", blocked: `potential ${threat.name}` };
      }
    }
  }

  let content = raw;
  if (content.length > maxChars) {
    const head = Math.floor(maxChars * 0.7);
    const tail = Math.floor(maxChars * 0.2);
    content = `${content.slice(0, head)}\n[...truncated ${name}: kept ${head}+${tail} of ${raw.length} chars. Use file tools to read the rest.]\n${content.slice(-tail)}`;
  }

  return { name, path: filePath, content };
}
