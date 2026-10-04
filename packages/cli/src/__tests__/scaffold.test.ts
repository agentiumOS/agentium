import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newProject } from "../commands/new.js";
import { installSkill } from "../commands/skills.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "agentium-cli-test-"));
  directories.push(dir);
  return dir;
}
it.each(["../escape", "a/b", "/tmp/absolute", 'bad"json', "a b", ".", "@scope/project", "node_modules"])(
  "rejects unsafe project name %s",
  async (name) => {
    const cwd = await temporary();
    await expect(newProject(name, "basic", { cwd })).rejects.toThrow("Project name");
  },
);
it("refuses an existing destination before changing its contents", async () => {
  const cwd = await temporary();
  await mkdir(join(cwd, "existing"));
  await writeFile(join(cwd, "existing/package.json"), "preserve");
  await expect(newProject("existing", "basic", { cwd })).rejects.toThrow("already exists");
  expect(await readFile(join(cwd, "existing/package.json"), "utf8")).toBe("preserve");
});
it.each(["basic", "rag", "voice", "browser"])(
  "generates bounded dependency ranges and setup instructions for %s",
  async (template) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = await temporary();
    await newProject(template, template, { cwd });
    const pkg = JSON.parse(await readFile(join(cwd, template, "package.json"), "utf8"));
    expect(pkg.name).toBe(template);
    expect(Object.values(pkg.dependencies)).not.toContain("*");
    expect(pkg.engines.node).toContain("22.18.0");
    const code = await readFile(join(cwd, template, "src/index.ts"), "utf8");
    if (template === "rag") expect(code).toContain("documents: hits");
    if (template === "voice") expect(code).toContain("provider: new OpenAIRealtimeProvider");
    expect(await readFile(join(cwd, template, "README.md"), "utf8")).toContain("OPENAI_API_KEY");
  },
);
it("checks local skill existence and never silently accepts a missing skill", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const cwd = await temporary();
  await expect(installSkill(join(cwd, "missing"))).rejects.toThrow("Local skill");
  await expect(installSkill(cwd)).rejects.toThrow("Local skill");
  await writeFile(join(cwd, "SKILL.md"), "# Local skill");
  await expect(installSkill(cwd)).resolves.toBeUndefined();
});
it.each(["--global", "--prefix=/tmp", "", "package\n--global"])("rejects option injection %s", async (source) => {
  await expect(installSkill(source)).rejects.toThrow("npm flags");
});

it("supports quoted local paths with spaces and requires the exact skill filename", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const cwd = await temporary();
  const path = join(cwd, "my local skill");
  await mkdir(path);
  await writeFile(join(path, "SKILL.md"), "# Skill");
  await expect(installSkill(path)).resolves.toBeUndefined();
  await writeFile(join(path, "NOTSKILL.md"), "# Other");
  await expect(installSkill(join(path, "NOTSKILL.md"))).rejects.toThrow("Local skill");
});
