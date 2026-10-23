import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../agent/agent.js";
import type { ModelProvider } from "../../models/provider.js";
import { SkillMdManager } from "../skill-md.js";

describe("pinned skill snapshots", () => {
  const roots: string[] = [];
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "agentium-skill-snapshot-"));
    roots.push(root);
    const dir = join(root, "query-postgres");
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: query-postgres\ndescription: Query safely\nversion: 1\n---\n\nKeep exact predicates.\n",
    );
    await writeFile(join(dir, "references", "joins.md"), "Use every composite key. 界😊\n");
    return { root, dir };
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps exact instruction and reference content after source edits or removal", async () => {
    const { root, dir } = await fixture();
    const snapshot = await new SkillMdManager({ dirs: [root] }).createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    expect(JSON.stringify(snapshot)).not.toContain(root);
    await writeFile(join(dir, "references", "joins.md"), "Changed after admission");
    await rm(root, { recursive: true, force: true });
    const restored = new SkillMdManager({ snapshot });
    expect(await restored.list()).toEqual([{ name: "query-postgres", description: "Query safely" }]);
    expect((await restored.get("query-postgres"))?.body).toBe("Keep exact predicates.");
    const returned = await restored.get("query-postgres");
    if (!returned) throw new Error("Missing pinned skill");
    returned.body = "Caller mutation";
    expect((await restored.get("query-postgres"))?.body).toBe("Keep exact predicates.");
    expect(await restored.readReference("query-postgres", "references/joins.md")).toBe(
      "Use every composite key. 界😊\n",
    );
    expect(await restored.readReference("query-postgres", "../secret")).toBe("Invalid path.");
    for (const path of ["/absolute", "references\\other", "references//other", "references/./other"]) {
      expect(await restored.readReference("query-postgres", path)).toBe("Invalid path.");
    }
    expect(await restored.readReference("query-postgres", "references/missing.md")).toBe(
      "File not found: references/missing.md",
    );
    snapshot.skills[0].files["references/joins.md"] = "caller mutation";
    expect(await restored.readReference("query-postgres", "references/joins.md")).toBe(
      "Use every composite key. 界😊\n",
    );
  });

  it("has stable identity and rejects changed bytes or versions", async () => {
    const { root, dir } = await fixture();
    const manager = new SkillMdManager({ dirs: [root] });
    const first = await manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    const same = await manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    expect(same.digest).toBe(first.digest);
    const tampered = structuredClone(first);
    tampered.skills[0].files["SKILL.md"] += "Tampered";
    expect(() => new SkillMdManager({ snapshot: tampered })).toThrow(/digest/);
    expect(() => new SkillMdManager({ snapshot: { ...first, version: 2 } })).toThrow();
    await writeFile(join(dir, "references", "joins.md"), "New version");
    const changed = await manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    expect(changed.digest).not.toBe(first.digest);
    const pinned = new SkillMdManager({ snapshot: first });
    await expect(pinned.createSnapshot({ maxBytes: 5, maxFiles: 10 })).rejects.toThrow(/byte/);
    await expect(pinned.createSnapshot({ maxBytes: 16_384, maxFiles: 1 })).rejects.toThrow(/file/);
  });

  it("fails an incomplete capture instead of truncating and refuses filesystem links", async () => {
    const { root, dir } = await fixture();
    const manager = new SkillMdManager({ dirs: [root] });
    await expect(manager.createSnapshot({ maxBytes: 5, maxFiles: 10 })).rejects.toThrow(/byte/);
    await expect(manager.createSnapshot({ maxBytes: 16_384, maxFiles: 1 })).rejects.toThrow(/file/);
    await symlink(join(dir, "SKILL.md"), join(dir, "references", "linked.md"));
    await expect(manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 })).rejects.toThrow(/symbolic/);
  });

  it("uses UTF-8 byte limits and does not load a file that exceeds remaining capacity", async () => {
    const { root, dir } = await fixture();
    const manager = new SkillMdManager({ dirs: [root] });
    const snapshot = await manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    const exact = snapshot.skills
      .flatMap((skill) => Object.values(skill.files))
      .reduce((sum, file) => sum + Buffer.byteLength(file), 0);
    expect((await manager.createSnapshot({ maxBytes: exact, maxFiles: 2 })).digest).toBe(snapshot.digest);
    await expect(manager.createSnapshot({ maxBytes: exact - 1, maxFiles: 2 })).rejects.toThrow(/byte/);
    await writeFile(join(dir, "references", "large.txt"), "");
    await truncate(join(dir, "references", "large.txt"), 32 * 1024 * 1024);
    await expect(manager.createSnapshot({ maxBytes: 1024, maxFiles: 10 })).rejects.toThrow(/byte/);
    const reordered = {
      ...snapshot,
      skills: snapshot.skills
        .map((skill) => ({ ...skill, files: Object.fromEntries(Object.entries(skill.files).reverse()) }))
        .reverse(),
    };
    expect(
      (await new SkillMdManager({ snapshot: reordered }).createSnapshot({ maxBytes: exact, maxFiles: 2 })).digest,
    ).toBe(snapshot.digest);
  });

  it("retains filenames that collide with Object prototype names", async () => {
    const { root, dir } = await fixture();
    await writeFile(join(dir, "__proto__"), "Exact named reference");
    const snapshot = await new SkillMdManager({ dirs: [root] }).createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    const restored = new SkillMdManager({ snapshot: JSON.parse(JSON.stringify(snapshot)) });
    expect(await restored.readReference("query-postgres", "__proto__")).toBe("Exact named reference");
    expect(Object.getPrototypeOf(snapshot.skills[0].files)).toBe(Object.prototype);
  });

  it("rejects ambiguous catalogs and mixed snapshot/filesystem configuration", async () => {
    const { root } = await fixture();
    const manager = new SkillMdManager({ dirs: [root, root] });
    await expect(manager.createSnapshot({ maxBytes: 16_384, maxFiles: 10 })).rejects.toThrow(/Duplicate/);
    const snapshot = await new SkillMdManager({ dirs: [root] }).createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    expect(() => new SkillMdManager({ dirs: [root], snapshot })).toThrow(/either/);
  });

  it("uses the pinned catalog through the ordinary Agent skill tools", async () => {
    const { root } = await fixture();
    const snapshot = await new SkillMdManager({ dirs: [root] }).createSnapshot({ maxBytes: 16_384, maxFiles: 10 });
    await rm(root, { recursive: true, force: true });
    let calls = 0;
    const provider: ModelProvider = {
      providerId: "fixture",
      modelId: "pinned-skills",
      async generate(messages) {
        const first = calls++ === 0;
        if (first) expect(JSON.stringify(messages)).toContain("query-postgres: Query safely");
        else {
          expect(
            messages.some((message) => message.role === "tool" && message.content === "Keep exact predicates."),
          ).toBe(true);
          expect(
            messages.some(
              (message) => message.role === "tool" && message.content === "Use every composite key. 界😊\n",
            ),
          ).toBe(true);
        }
        return {
          message: first
            ? {
                role: "assistant",
                content: null,
                toolCalls: [
                  { id: "instructions", name: "get_skill_instructions", arguments: { name: "query-postgres" } },
                  {
                    id: "reference",
                    name: "get_skill_reference",
                    arguments: { name: "query-postgres", path: "references/joins.md" },
                  },
                ],
              }
            : { role: "assistant", content: "Done" },
          finishReason: first ? "tool_calls" : "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          raw: {},
        };
      },
      async *stream() {
        yield { type: "text", text: "Unused fixture stream" };
      },
    };
    const agent = new Agent({ name: "pinned", model: provider, register: false, skillSnapshot: snapshot });
    try {
      expect(agent.listTools()).toEqual(
        expect.arrayContaining(["list_skills", "get_skill_instructions", "get_skill_reference"]),
      );
      expect(agent.getRecoveryDescriptor().unsupported).toContain("skillSnapshot");
      expect((await agent.run("Inspect the query rules")).text).toBe("Done");
      expect(calls).toBe(2);
    } finally {
      await agent.close();
    }
  });
});
