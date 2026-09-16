import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillMd, SkillMdManager } from "../skill-md.js";

describe("parseSkillMd", () => {
  it("reads YAML frontmatter", () => {
    const skill = parseSkillMd(`---
name: pdf-export
description: Turn a page into a PDF
---

Use wkhtmltopdf.
`);
    expect(skill?.name).toBe("pdf-export");
    expect(skill?.description).toContain("PDF");
    expect(skill?.body).toContain("wkhtmltopdf");
  });

  it("rejects invalid names", () => {
    expect(
      parseSkillMd(`---
name: Not Valid
description: x
---
body
`),
    ).toBeNull();
  });
});

describe("SkillMdManager", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("indexes SKILL.md folders and loads the body on demand", async () => {
    dir = await mkdtemp(join(tmpdir(), "skills-"));
    const skillDir = join(dir, "pdf-export");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: pdf-export
description: Make PDFs
---

Always use A4.
`,
    );

    const mgr = new SkillMdManager({ dirs: [dir] });
    const listed = await mgr.list();
    expect(listed).toEqual([{ name: "pdf-export", description: "Make PDFs" }]);

    const full = await mgr.get("pdf-export");
    expect(full?.body).toContain("A4");

    const tools = mgr.getTools();
    expect(tools.map((t) => t.name)).toEqual(["list_skills", "get_skill_instructions", "get_skill_reference"]);
  });
});
