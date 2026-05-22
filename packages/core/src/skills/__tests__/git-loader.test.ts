import { describe, expect, it } from "vitest";
import { GitSkillLoader } from "../loaders/git.js";

describe("GitSkillLoader.canLoad", () => {
  const loader = new GitSkillLoader();

  it("matches git+https URLs", () => {
    expect(loader.canLoad("git+https://github.com/me/skill.git")).toBe(true);
  });

  it("matches git+ssh URLs", () => {
    expect(loader.canLoad("git+ssh://git@github.com/me/skill.git")).toBe(true);
  });

  it("matches plain GitHub .git URLs", () => {
    expect(loader.canLoad("https://github.com/me/skill.git")).toBe(true);
  });

  it("does not match non-git sources", () => {
    expect(loader.canLoad("./local")).toBe(false);
    expect(loader.canLoad("npm:my-skill")).toBe(false);
    expect(loader.canLoad("https://example.com/page.html")).toBe(false);
  });
});

describe("GitSkillLoader source parsing", () => {
  const loader = new GitSkillLoader();

  it("parses ref from #suffix", () => {
    const parsed = (loader as any).parseSource("git+https://github.com/me/skill.git#v1.0.0");
    expect(parsed.repo).toBe("https://github.com/me/skill.git");
    expect(parsed.ref).toBe("v1.0.0");
  });

  it("defaults ref to main", () => {
    const parsed = (loader as any).parseSource("git+https://github.com/me/skill.git");
    expect(parsed.ref).toBe("main");
  });

  it("respects loader defaultRef", () => {
    const l = new GitSkillLoader({ defaultRef: "master" });
    const parsed = (l as any).parseSource("git+https://github.com/me/skill.git");
    expect(parsed.ref).toBe("master");
  });

  it("parses subdir param", () => {
    const parsed = (loader as any).parseSource("git+https://github.com/me/monorepo.git?subdir=packages%2Fmy-skill");
    expect(parsed.subdir).toBe("packages/my-skill");
  });
});
