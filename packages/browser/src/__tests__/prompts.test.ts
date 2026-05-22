import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserMessage, summarizeAction } from "../prompts.js";

describe("buildSystemPrompt", () => {
  it("includes viewport dimensions", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 });
    expect(prompt).toContain("1280");
    expect(prompt).toContain("720");
  });

  it("includes available actions", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 });
    expect(prompt).toContain("click");
    expect(prompt).toContain("type");
    expect(prompt).toContain("scroll");
    expect(prompt).toContain("navigate");
    expect(prompt).toContain("done");
    expect(prompt).toContain("fail");
  });

  it("includes extra instructions when provided", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, "Focus on accessibility");
    expect(prompt).toContain("Focus on accessibility");
  });

  it("includes credential keys section when provided", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, undefined, ["email", "password"]);
    expect(prompt).toContain("Secure Credentials");
    expect(prompt).toContain("{{email}}");
    expect(prompt).toContain("{{password}}");
  });

  it("does not include credential section when keys are empty", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, undefined, []);
    expect(prompt).not.toContain("Secure Credentials");
  });
});

describe("buildUserMessage", () => {
  it("includes task and URL", () => {
    const msg = buildUserMessage("Find prices", "https://example.com", "Example", 0, []);
    expect(msg).toContain("Find prices");
    expect(msg).toContain("https://example.com");
  });

  it("includes step number (1-indexed)", () => {
    const msg = buildUserMessage("task", "url", "title", 4, []);
    expect(msg).toContain("Step:** 5");
  });

  it("includes action history", () => {
    const msg = buildUserMessage("task", "url", "title", 1, ["Clicked button", "Typed hello"]);
    expect(msg).toContain("Clicked button");
    expect(msg).toContain("Typed hello");
  });

  it("includes DOM snapshot when provided", () => {
    const msg = buildUserMessage("task", "url", "title", 0, [], "<dom>content</dom>");
    expect(msg).toContain("<dom>content</dom>");
  });
});

describe("summarizeAction", () => {
  it("summarizes click action", () => {
    expect(summarizeAction({ action: "click", x: 100, y: 200, description: "button" })).toContain("Clicked");
  });

  it("summarizes type action", () => {
    expect(summarizeAction({ action: "type", text: "hello" })).toContain("hello");
  });

  it("summarizes done action", () => {
    expect(summarizeAction({ action: "done", result: "Task complete" })).toContain("Task complete");
  });

  it("summarizes fail action", () => {
    expect(summarizeAction({ action: "fail", reason: "Page not found" })).toContain("Page not found");
  });

  it("falls back to JSON for unknown actions", () => {
    const result = summarizeAction({ action: "custom", data: 42 });
    expect(result).toContain("custom");
  });
});
