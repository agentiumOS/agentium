import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";
import type { ToolDef } from "../tools/types.js";
import { getArtifact, listArtifacts, storeArtifact } from "./artifact-store.js";

/**
 * Returns the pair of tools an Agent uses to interact with the Memory Pointer
 * artifact store: `storeArtifact` and `getArtifact`.
 *
 * Both tools share the same `RunContext.sessionState`, so an artifact stored on
 * one turn is retrievable on later turns within the same session.
 */
export function createArtifactTools(): ToolDef[] {
  const storeTool = defineTool({
    name: "storeArtifact",
    description:
      "Store a large value (a string, JSON object, log dump, etc.) outside the conversation and get a short pointer back. Use this when a tool result is too big to keep inline. Subsequent tools can call getArtifact with the returned pointer to read the full value.",
    parameters: z.object({
      name: z.string().describe("A short human-readable name for the artifact (e.g. 'q4-sales-rows')"),
      value: z
        .string()
        .describe("The value to store. Pass a string; if you need to store structured data, JSON.stringify it first."),
      contentType: z
        .string()
        .optional()
        .describe("Optional MIME-type-style hint (e.g. 'application/json', 'text/log')"),
    }),
    execute: async ({ name, value, contentType }, ctx) => {
      const ptr = storeArtifact(ctx, value, { name, contentType });
      return JSON.stringify({
        pointer: ptr.pointer,
        preview: ptr.preview,
        sizeBytes: ptr.sizeBytes,
        name,
      });
    },
  });

  const getTool = defineTool({
    name: "getArtifact",
    description:
      "Read the full value of a stored artifact by its pointer (e.g. 'art:abc-123') or by the name supplied to storeArtifact.",
    parameters: z.object({
      pointerOrName: z.string().describe("Either an 'art:...' pointer or the artifact name"),
    }),
    execute: async ({ pointerOrName }, ctx) => {
      const art = getArtifact(ctx, pointerOrName);
      if (!art) return `[no artifact found for '${pointerOrName}']`;
      const v = art.value;
      return typeof v === "string" ? v : JSON.stringify(v);
    },
  });

  const listTool = defineTool({
    name: "listArtifacts",
    description: "List all stored artifacts in the current session with their pointers, names, sizes, and previews.",
    parameters: z.object({}),
    execute: async (_args, ctx) => {
      const items = listArtifacts(ctx).map((a) => ({
        pointer: `art:${a.id}`,
        name: a.name,
        sizeBytes: a.sizeBytes,
        preview: a.preview,
        contentType: a.contentType,
        storedAt: a.storedAt,
      }));
      return JSON.stringify(items);
    },
  });

  return [storeTool, getTool, listTool];
}
