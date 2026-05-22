import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Skill, SkillLoader } from "../types.js";
import { LocalSkillLoader } from "./local.js";

const execFileAsync = promisify(execFile);

export interface GitSkillLoaderConfig {
  /**
   * Local directory where cloned skills are cached. Defaults to a tempdir per process.
   * Setting an explicit path lets you cache skills across runs.
   */
  cacheDir?: string;
  /** Default ref to checkout when none is specified in the URL. */
  defaultRef?: string;
}

/**
 * Loader for git-installable skills.
 *
 * Accepted source formats:
 *   git+https://github.com/me/my-skill.git
 *   git+https://github.com/me/my-skill.git#v1.2.3       (tag)
 *   git+https://github.com/me/my-skill.git#main          (branch / ref)
 *   git+ssh://git@github.com/me/my-skill.git
 *
 * The repository must contain a `skill.json` manifest at the root (or in a
 * subdir specified via `?subdir=path/in/repo`).
 */
export class GitSkillLoader implements SkillLoader {
  private cacheDir: string | null;
  private defaultRef: string;
  private resolvedCacheDir: string | null = null;

  constructor(config: GitSkillLoaderConfig = {}) {
    this.cacheDir = config.cacheDir ?? null;
    this.defaultRef = config.defaultRef ?? "main";
  }

  canLoad(source: string): boolean {
    return /^git\+(https?|ssh):\/\//.test(source) || /^https:\/\/github\.com\/.+\.git/.test(source);
  }

  private async ensureCacheDir(): Promise<string> {
    if (this.resolvedCacheDir) return this.resolvedCacheDir;
    if (this.cacheDir) {
      await mkdir(this.cacheDir, { recursive: true });
      this.resolvedCacheDir = this.cacheDir;
    } else {
      this.resolvedCacheDir = await mkdtemp(join(tmpdir(), "agentium-skill-"));
    }
    return this.resolvedCacheDir;
  }

  private parseSource(source: string): { repo: string; ref: string; subdir?: string } {
    let normalized = source.replace(/^git\+/, "");

    let subdir: string | undefined;
    const subdirMatch = normalized.match(/[?&]subdir=([^&#]+)/);
    if (subdirMatch) {
      subdir = decodeURIComponent(subdirMatch[1]);
      normalized = normalized.replace(/[?&]subdir=[^&#]+/, "");
    }

    let ref = this.defaultRef;
    const hashIdx = normalized.lastIndexOf("#");
    if (hashIdx > 8 /* skip "https://" */) {
      ref = normalized.slice(hashIdx + 1);
      normalized = normalized.slice(0, hashIdx);
    }
    return { repo: normalized, ref, subdir };
  }

  private repoCacheKey(repo: string, ref: string): string {
    return `${repo}@${ref}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  }

  async load(source: string): Promise<Skill> {
    const { repo, ref, subdir } = this.parseSource(source);
    const baseDir = await this.ensureCacheDir();
    const key = this.repoCacheKey(repo, ref);
    const cloneDir = join(baseDir, key);

    if (!existsSync(cloneDir)) {
      await mkdir(cloneDir, { recursive: true });
      try {
        await execFileAsync("git", ["clone", "--depth=1", "--branch", ref, repo, cloneDir]);
      } catch {
        // Some refs (commit SHAs) can't be cloned with --branch; fall back to full clone + checkout.
        await execFileAsync("git", ["clone", repo, cloneDir]);
        await execFileAsync("git", ["-C", cloneDir, "checkout", ref]);
      }
    }

    const skillDir = subdir ? join(cloneDir, subdir) : cloneDir;
    const local = new LocalSkillLoader();
    return local.load(skillDir);
  }
}
