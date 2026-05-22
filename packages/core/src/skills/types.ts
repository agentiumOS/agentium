import type { ToolDef } from "../tools/types.js";

/**
 * A Skill is a pre-packaged bundle of tools and optional instructions.
 * It encapsulates domain expertise that can be loaded from various sources.
 */
export interface Skill {
  /** Unique name for this skill. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Semver version string. */
  version: string;
  /** Tools provided by this skill. */
  tools: ToolDef[];
  /** Optional instructions fragment injected into the system prompt when this skill is active. */
  instructions?: string;
  /** Metadata — author, license, tags, etc. */
  metadata?: Record<string, unknown>;
}

/**
 * Manifest file (skill.json) loaded from a skill directory.
 */
export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  /** Relative path to the main module that exports tools. */
  main: string;
  /** Optional instructions text or path to an instructions file. */
  instructions?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface for skill loaders. Each loader knows how to load skills from a
 * specific source type (filesystem, npm, remote URL).
 */
export interface SkillLoader {
  /** Returns true if this loader can handle the given source string. */
  canLoad(source: string): boolean;
  /** Load a skill from the source. */
  load(source: string): Promise<Skill>;
}

/** Input type for loadSkill — a source string (path, package name, or URL). */
export type SkillSource = string;
