import { extname } from "node:path";
import type { AudioPart, ContentPart, FilePart, ImagePart } from "../../models/types.js";

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mp3",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

function inferMimeType(path: string): string | undefined {
  return EXT_TO_MIME[extname(path).toLowerCase()];
}

/**
 * Fetch a remote URL and return its base64 content + MIME type.
 * Uses the global `fetch` API (Node 20+).
 */
export async function fetchAsBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchAsBase64: failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mimeType: contentType };
}

/**
 * Read a local file and return a `ContentPart` shaped for the given (or inferred) MIME type.
 * - `image/*`  -> `ImagePart`
 * - `audio/*`  -> `AudioPart`
 * - everything else (video, PDF, ...) -> `FilePart`
 */
export async function partsFromFile(path: string, mimeType?: string): Promise<ContentPart> {
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(path);
  const data = buf.toString("base64");
  const mt = mimeType ?? inferMimeType(path);
  if (!mt) {
    throw new Error(`partsFromFile: could not infer MIME type for ${path}; pass mimeType explicitly`);
  }
  if (mt.startsWith("image/")) {
    return { type: "image", data, mimeType: mt as ImagePart["mimeType"] };
  }
  if (mt.startsWith("audio/")) {
    return { type: "audio", data, mimeType: mt as AudioPart["mimeType"] };
  }
  const filename = path.split("/").pop();
  return { type: "file", data, mimeType: mt, filename } satisfies FilePart;
}
