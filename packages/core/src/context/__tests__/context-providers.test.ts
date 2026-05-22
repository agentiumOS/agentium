import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunContext } from "../../agent/run-context.js";
import { EventBus } from "../../events/event-bus.js";
import {
  DatabaseContextProvider,
  FilesystemContextProvider,
  HttpContextProvider,
  resolveContextProviders,
} from "../context-providers.js";

function makeCtx(): RunContext {
  return new RunContext({ sessionId: "s1", eventBus: new EventBus() });
}

describe("FilesystemContextProvider", () => {
  it("reads files matching a glob", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-fs-"));
    await writeFile(join(dir, "a.md"), "# A");
    await writeFile(join(dir, "b.md"), "# B");
    await writeFile(join(dir, "ignore.txt"), "skip me");

    const p = new FilesystemContextProvider({ basePath: dir, glob: "*.md" });
    const out = await p.fetchContext("", makeCtx());
    expect(out).toContain("a.md");
    expect(out).toContain("# A");
    expect(out).toContain("b.md");
    expect(out).not.toContain("skip me");
  });

  it("respects explicit files list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-fs-"));
    await writeFile(join(dir, "a.txt"), "alpha");
    await writeFile(join(dir, "b.txt"), "beta");

    const p = new FilesystemContextProvider({ basePath: dir, files: ["b.txt"] });
    const out = await p.fetchContext("", makeCtx());
    expect(out).toContain("beta");
    expect(out).not.toContain("alpha");
  });

  it("caps total chars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-fs-"));
    await writeFile(join(dir, "x.txt"), "x".repeat(10_000));
    const p = new FilesystemContextProvider({
      basePath: dir,
      files: ["x.txt"],
      maxCharsPerFile: 100,
      maxTotalChars: 200,
    });
    const out = await p.fetchContext("", makeCtx());
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("truncated");
  });
});

describe("HttpContextProvider", () => {
  it("fetches body and applies transform", async () => {
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><body>hi</body></html>",
    }));
    try {
      const p = new HttpContextProvider({
        url: "https://example.com",
        transform: (b) => b.replace(/<[^>]+>/g, " "),
      });
      const out = await p.fetchContext("", makeCtx());
      expect(out).toContain("hi");
      expect(out).not.toContain("<html>");
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });

  it("respects allowedHosts SSRF policy", async () => {
    const p = new HttpContextProvider({ url: "https://evil.com/", allowedHosts: ["example.com"] });
    await expect(p.fetchContext("", makeCtx())).rejects.toThrow(/Host blocked/);
  });

  it("returns error string on non-ok responses", async () => {
    const origFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Err",
      text: async () => "",
    }));
    try {
      const p = new HttpContextProvider({ url: "https://example.com" });
      const out = await p.fetchContext("", makeCtx());
      expect(out).toContain("HTTP fetch failed");
    } finally {
      (globalThis as any).fetch = origFetch;
    }
  });
});

describe("DatabaseContextProvider", () => {
  it("delegates to user-supplied fetch", async () => {
    const ctx = makeCtx();
    const p = new DatabaseContextProvider({ fetch: async (rc) => `userId=${rc.sessionId}` });
    expect(await p.fetchContext("", ctx)).toBe("userId=s1");
  });
});

describe("resolveContextProviders", () => {
  it("renders blocks with labeled headers", async () => {
    const ctx = makeCtx();
    const a = new DatabaseContextProvider({ label: "a", fetch: async () => "alpha" });
    const b = new DatabaseContextProvider({ label: "b", fetch: async () => "beta" });
    const out = await resolveContextProviders([a, b], "query", ctx);
    expect(out).toContain("## Context: a");
    expect(out).toContain("alpha");
    expect(out).toContain("## Context: b");
    expect(out).toContain("beta");
  });

  it("captures errors per-provider without failing the whole batch", async () => {
    const ctx = makeCtx();
    const good = new DatabaseContextProvider({ label: "good", fetch: async () => "ok" });
    const bad = new DatabaseContextProvider({
      label: "bad",
      fetch: async () => {
        throw new Error("boom");
      },
    });
    const out = await resolveContextProviders([good, bad], "query", ctx);
    expect(out).toContain("good");
    expect(out).toContain("bad");
    expect(out).toContain("boom");
  });

  it("omits empty blocks", async () => {
    const ctx = makeCtx();
    const empty = new DatabaseContextProvider({ label: "empty", fetch: async () => "" });
    const nonempty = new DatabaseContextProvider({ label: "x", fetch: async () => "y" });
    const out = await resolveContextProviders([empty, nonempty], "q", ctx);
    expect(out).not.toContain("empty");
    expect(out).toContain("Context: x");
  });
});
