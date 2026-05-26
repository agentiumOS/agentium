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
  it("summarizes click action (coordinate)", () => {
    expect(summarizeAction({ action: "click", x: 100, y: 200, description: "button" })).toContain("Clicked");
  });

  it("summarizes click action (indexed)", () => {
    const out = summarizeAction({ action: "click", index: 7, description: "the 'Cheapest' tab" });
    expect(out).toContain("[7]");
    expect(out).toContain("Cheapest");
  });

  it("summarizes type action (indexed)", () => {
    const out = summarizeAction({ action: "type", index: 3, text: "hello" });
    expect(out).toContain("[3]");
    expect(out).toContain("hello");
  });

  it("summarizes find_text / send_keys / select_dropdown / extract / tool", () => {
    expect(summarizeAction({ action: "find_text", text: "Annual" })).toContain("Annual");
    expect(summarizeAction({ action: "send_keys", keys: "Tab Enter" })).toContain("Tab Enter");
    expect(summarizeAction({ action: "select_dropdown", index: 2, text: "US" })).toContain('"US"');
    expect(summarizeAction({ action: "extract", query: "prices" })).toContain("prices");
    expect(summarizeAction({ action: "tool", name: "get_2fa" })).toContain("get_2fa");
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

describe("buildSystemPrompt (new options)", () => {
  it("advertises indexed click as preferred", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 });
    expect(prompt).toContain("click — by index (preferred)");
    expect(prompt).toContain('"index"');
  });

  it("lists new actions: find_text, send_keys, select_dropdown, upload_file, extract", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 });
    expect(prompt).toContain("find_text");
    expect(prompt).toContain("send_keys");
    expect(prompt).toContain("select_dropdown");
    expect(prompt).toContain("upload_file");
    expect(prompt).toContain("extract");
  });

  it("includes evaluate action only when allowEvaluate is set", () => {
    const off = buildSystemPrompt({ width: 1280, height: 720 });
    expect(off).not.toContain("### evaluate");
    const on = buildSystemPrompt({ width: 1280, height: 720 }, undefined, undefined, { allowEvaluate: true });
    expect(on).toContain("### evaluate");
  });

  it("lists registered custom tools when provided", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, undefined, undefined, {
      tools: [
        {
          name: "get_2fa",
          description: "Fetch the current 2FA code",
          // biome-ignore lint/suspicious/noExplicitAny: test stub
          parameters: { _def: {} } as any,
          execute: async () => "123456",
        },
      ],
    });
    expect(prompt).toContain("get_2fa");
    expect(prompt).toContain("Fetch the current 2FA code");
  });

  it("honors overrideSystemMessage but still appends credentials + format", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, undefined, ["email"], {
      overrideSystemMessage: "You are a TOTALLY CUSTOM agent.",
    });
    expect(prompt).toContain("You are a TOTALLY CUSTOM agent.");
    expect(prompt).toContain("{{email}}");
    expect(prompt).toContain("Response Format");
  });

  it("notes vision disabled when useVision=false", () => {
    const prompt = buildSystemPrompt({ width: 1280, height: 720 }, undefined, undefined, { useVision: false });
    expect(prompt.toLowerCase()).toContain("vision is disabled");
  });
});
