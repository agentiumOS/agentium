import { describe, expect, it } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import {
  ARTIFACT_POINTER_PREFIX,
  approxByteSize,
  getArtifact,
  isPointer,
  listArtifacts,
  storeArtifact,
} from "../artifact-store.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("ArtifactStore", () => {
  describe("storeArtifact", () => {
    it("returns a pointer prefixed with art:", () => {
      const ctx = makeCtx();
      const ptr = storeArtifact(ctx, "hello world");
      expect(ptr.pointer).toMatch(/^art:[0-9a-f-]{36}$/);
      expect(ptr.preview).toBe("hello world");
    });

    it("computes size in bytes", () => {
      const ctx = makeCtx();
      const ptr = storeArtifact(ctx, "abc");
      expect(ptr.sizeBytes).toBe(3);
    });

    it("truncates preview when value is long", () => {
      const ctx = makeCtx();
      const longText = "x".repeat(500);
      const ptr = storeArtifact(ctx, longText, { previewChars: 100 });
      expect(ptr.preview.length).toBeLessThan(longText.length);
      expect(ptr.preview).toContain("more chars");
    });

    it("stores under name when provided and is retrievable by name", () => {
      const ctx = makeCtx();
      storeArtifact(ctx, "log content", { name: "logs" });
      const art = getArtifact(ctx, "logs");
      expect(art).not.toBeNull();
      expect(art?.value).toBe("log content");
    });

    it("serializes non-string values for size and preview", () => {
      const ctx = makeCtx();
      const obj = { rows: [1, 2, 3, 4, 5] };
      const ptr = storeArtifact(ctx, obj);
      expect(ptr.preview).toContain("rows");
      expect(ptr.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe("getArtifact", () => {
    it("returns null for unknown pointer", () => {
      const ctx = makeCtx();
      expect(getArtifact(ctx, "art:does-not-exist")).toBeNull();
    });

    it("returns null for unknown name", () => {
      const ctx = makeCtx();
      expect(getArtifact(ctx, "missing-name")).toBeNull();
    });

    it("returns the artifact by pointer", () => {
      const ctx = makeCtx();
      const ptr = storeArtifact(ctx, { foo: "bar" });
      const art = getArtifact(ctx, ptr.pointer);
      expect(art).not.toBeNull();
      expect(art?.value).toEqual({ foo: "bar" });
    });
  });

  describe("listArtifacts", () => {
    it("returns empty when none stored", () => {
      const ctx = makeCtx();
      expect(listArtifacts(ctx)).toEqual([]);
    });

    it("returns all stored artifacts without duplicates from name aliases", () => {
      const ctx = makeCtx();
      storeArtifact(ctx, "a", { name: "x" });
      storeArtifact(ctx, "b");
      storeArtifact(ctx, "c", { name: "y" });
      const list = listArtifacts(ctx);
      expect(list).toHaveLength(3);
    });
  });

  describe("helpers", () => {
    it("isPointer returns true for art: strings", () => {
      expect(isPointer("art:abc")).toBe(true);
      expect(isPointer("not-art:abc")).toBe(false);
      expect(isPointer(123)).toBe(false);
    });

    it("ARTIFACT_POINTER_PREFIX matches the format used by store", () => {
      const ctx = makeCtx();
      const ptr = storeArtifact(ctx, "x");
      expect(ptr.pointer.startsWith(ARTIFACT_POINTER_PREFIX)).toBe(true);
    });

    it("approxByteSize handles strings and objects", () => {
      expect(approxByteSize("abc")).toBe(3);
      expect(approxByteSize({ k: "v" })).toBeGreaterThan(0);
    });
  });
});
