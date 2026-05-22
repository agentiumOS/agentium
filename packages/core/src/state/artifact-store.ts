import { v4 as uuidv4 } from "uuid";
import type { RunContext } from "../agent/run-context.js";

/**
 * Memory Pointer Pattern - stores large/structured data outside the LLM context
 * and exposes a short pointer (e.g. `art:550e8400-...`) plus a preview to the model.
 *
 * Artifacts live on `RunContext.sessionState["__artifacts"]` so they survive within
 * a single run / session but don't bloat the LLM prompt.
 */

const ARTIFACTS_KEY = "__artifacts";
const POINTER_PREFIX = "art:";

export interface StoredArtifact {
  id: string;
  /** Optional caller-supplied name for human-readable retrieval. */
  name?: string;
  /** The actual stored value. */
  value: unknown;
  /** Short text preview used in pointer responses. */
  preview: string;
  /** Approximate size of the original serialized value in bytes. */
  sizeBytes: number;
  /** When the artifact was stored. */
  storedAt: number;
  /** Mime type or content type hint. */
  contentType?: string;
}

export interface ArtifactPointer {
  pointer: string;
  preview: string;
  sizeBytes: number;
  name?: string;
}

function getArtifactsMap(ctx: RunContext): Map<string, StoredArtifact> {
  let map = ctx.getState<Map<string, StoredArtifact>>(ARTIFACTS_KEY);
  if (!map) {
    map = new Map();
    ctx.setState(ARTIFACTS_KEY, map);
  }
  return map;
}

function makePreview(value: unknown, maxChars = 200): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}... (${serialized.length - maxChars} more chars)`;
}

export function approxByteSize(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

/** Store an artifact and return its pointer + preview. */
export function storeArtifact(
  ctx: RunContext,
  value: unknown,
  opts: { name?: string; contentType?: string; previewChars?: number } = {},
): ArtifactPointer {
  const id = uuidv4();
  const preview = makePreview(value, opts.previewChars);
  const artifact: StoredArtifact = {
    id,
    name: opts.name,
    value,
    preview,
    sizeBytes: approxByteSize(value),
    storedAt: Date.now(),
    contentType: opts.contentType,
  };
  getArtifactsMap(ctx).set(id, artifact);
  if (opts.name) {
    // Allow lookup by name too (later writes with the same name overwrite the binding).
    getArtifactsMap(ctx).set(`name:${opts.name}`, artifact);
  }
  return {
    pointer: POINTER_PREFIX + id,
    preview,
    sizeBytes: artifact.sizeBytes,
    name: opts.name,
  };
}

/** Look up an artifact by its pointer (`art:...`) or by its caller-supplied name. */
export function getArtifact(ctx: RunContext, pointerOrName: string): StoredArtifact | null {
  const map = getArtifactsMap(ctx);
  if (pointerOrName.startsWith(POINTER_PREFIX)) {
    return map.get(pointerOrName.slice(POINTER_PREFIX.length)) ?? null;
  }
  return map.get(`name:${pointerOrName}`) ?? null;
}

/** List all artifacts stored in the current run/session. */
export function listArtifacts(ctx: RunContext): StoredArtifact[] {
  const seen = new Set<string>();
  const out: StoredArtifact[] = [];
  for (const [key, art] of getArtifactsMap(ctx).entries()) {
    if (key.startsWith("name:")) continue;
    if (seen.has(art.id)) continue;
    seen.add(art.id);
    out.push(art);
  }
  return out;
}

/** Convert a pointer string back to its raw artifact. Returns `null` if not found. */
export function isPointer(s: unknown): s is string {
  return typeof s === "string" && s.startsWith(POINTER_PREFIX);
}

export const ARTIFACT_POINTER_PREFIX = POINTER_PREFIX;
