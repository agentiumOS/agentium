import { describe, expect, it } from "vitest";
import { ToolkitCatalog, toolkitCatalog } from "../../toolkits/catalog.js";

describe("ToolkitCatalog", () => {
  it("lists all built-in toolkits", () => {
    const all = toolkitCatalog.list();
    expect(all.length).toBeGreaterThanOrEqual(18);
    const ids = all.map((t) => t.id);
    expect(ids).toContain("calculator");
    expect(ids).toContain("github");
    expect(ids).toContain("slack");
    expect(ids).toContain("jira");
    expect(ids).toContain("notion");
    expect(ids).toContain("whatsapp");
    expect(ids).toContain("gmail");
    expect(ids).toContain("google_calendar");
  });

  it("each entry has id, name, description, category, and configFields", () => {
    for (const entry of toolkitCatalog.list()) {
      expect(entry.id).toBeDefined();
      expect(entry.name).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.category).toBeDefined();
      expect(Array.isArray(entry.configFields)).toBe(true);
      expect(typeof entry.requiresCredentials).toBe("boolean");
    }
  });

  it("does not expose factory in list output", () => {
    const all = toolkitCatalog.list();
    for (const entry of all) {
      expect((entry as any).factory).toBeUndefined();
    }
  });

  it("get() returns a single entry", () => {
    const entry = toolkitCatalog.get("calculator");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Calculator");
    expect((entry as any).factory).toBeUndefined();
  });

  it("get() returns undefined for unknown id", () => {
    expect(toolkitCatalog.get("nonexistent")).toBeUndefined();
  });

  it("has() checks existence", () => {
    expect(toolkitCatalog.has("github")).toBe(true);
    expect(toolkitCatalog.has("nonexistent")).toBe(false);
  });

  it("create() instantiates a toolkit", () => {
    const tk = toolkitCatalog.create("calculator", { precision: 5 });
    expect(tk.name).toBe("calculator");
    const tools = tk.getTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("create() throws for unknown id", () => {
    expect(() => toolkitCatalog.create("nonexistent")).toThrow("Unknown toolkit");
  });

  it("credential-requiring toolkits have secret configFields", () => {
    const credToolkits = toolkitCatalog.list().filter((t) => t.requiresCredentials);
    expect(credToolkits.length).toBeGreaterThan(0);

    for (const tk of credToolkits) {
      const hasSecret = tk.configFields.some((f) => f.secret);
      expect(hasSecret).toBe(true);
    }
  });

  it("register() adds a custom toolkit type", () => {
    const custom = new ToolkitCatalog([]);
    expect(custom.has("custom")).toBe(false);

    custom.register({
      id: "custom",
      name: "Custom",
      description: "A custom toolkit",
      category: "utility",
      requiresCredentials: false,
      configFields: [],
      factory: () => ({ name: "custom", getTools: () => [] }) as any,
    });

    expect(custom.has("custom")).toBe(true);
    expect(custom.list()).toHaveLength(1);
  });
});
