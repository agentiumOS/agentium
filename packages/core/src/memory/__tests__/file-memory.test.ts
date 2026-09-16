import { describe, expect, it } from "vitest";
import { FileMemory } from "../file-memory.js";

describe("FileMemory", () => {
  it("adds entries until the cap, then asks to consolidate", async () => {
    const mem = new FileMemory({ memoryCharLimit: 20, userCharLimit: 20 });
    expect(await mem.add("memory", "bot", "hello")).toEqual({ ok: true });
    const overflow = await mem.add("memory", "bot", "this is way too long");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.current_entries).toEqual(["hello"]);
  });

  it("replaces and removes by unique substring", async () => {
    const mem = new FileMemory();
    await mem.add("user", "u1", "likes tea");
    await mem.replace("user", "u1", "tea", "likes coffee");
    expect(await mem.getEntries("user", "u1")).toEqual(["likes coffee"]);
    await mem.remove("user", "u1", "coffee");
    expect(await mem.getEntries("user", "u1")).toEqual([]);
  });
});
