import { describe, expect, it } from "vitest";
import { PiiGuard } from "../guards/pii-guard.js";

describe("PiiGuard", () => {
  it("scrubs emails with placeholder mode", () => {
    const guard = new PiiGuard({
      builtIn: ["email"],
      action: "placeholder",
    });
    const result = guard.scrub("Contact john@example.com for details");
    expect(result).not.toContain("john@example.com");
    expect(result).toContain("[EMAIL_");
  });

  it("scrubs phone numbers", () => {
    const guard = new PiiGuard({
      builtIn: ["phone"],
      action: "placeholder",
    });
    const result = guard.scrub("Call me at 555-123-4567");
    expect(result).not.toContain("555-123-4567");
    expect(result).toContain("[PHONE_");
  });

  it("scrubs SSN", () => {
    const guard = new PiiGuard({
      builtIn: ["ssn"],
      action: "placeholder",
    });
    const result = guard.scrub("SSN: 123-45-6789");
    expect(result).not.toContain("123-45-6789");
    expect(result).toContain("[SSN_");
  });

  it("scrubs credit cards", () => {
    const guard = new PiiGuard({
      builtIn: ["creditCard"],
      action: "placeholder",
    });
    const result = guard.scrub("Card: 4111-1111-1111-1111");
    expect(result).not.toContain("4111-1111-1111-1111");
    expect(result).toContain("[CREDITCARD_");
  });

  it("rehydrates placeholders", () => {
    const guard = new PiiGuard({
      builtIn: ["email"],
      action: "placeholder",
      rehydrate: true,
    });
    const scrubbed = guard.scrub("Email: john@example.com");
    expect(scrubbed).not.toContain("john@example.com");

    const rehydrated = guard.rehydrate(scrubbed);
    expect(rehydrated).toContain("john@example.com");
  });

  it("redact mode replaces with [REDACTED]", () => {
    const guard = new PiiGuard({
      builtIn: ["email"],
      action: "redact",
    });
    const result = guard.scrub("Email: john@example.com");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("john@example.com");
  });

  it("hash mode produces deterministic hashes", () => {
    const guard = new PiiGuard({
      builtIn: ["email"],
      action: "hash",
    });
    const result1 = guard.scrub("Email: john@example.com");
    guard.reset();
    const result2 = guard.scrub("Email: john@example.com");
    expect(result1).toEqual(result2);
  });

  it("handles custom patterns", () => {
    const guard = new PiiGuard({
      patterns: [{ name: "custom_id", regex: /ID-\d{6}/g }],
      action: "placeholder",
    });
    const result = guard.scrub("Your ID-123456 is active");
    expect(result).not.toContain("ID-123456");
    expect(result).toContain("[CUSTOM_ID_");
  });

  it("scrubs messages array", () => {
    const guard = new PiiGuard({
      builtIn: ["email"],
      action: "placeholder",
    });
    const messages = [
      { role: "user" as const, content: "My email is test@test.com" },
      { role: "assistant" as const, content: "I see your email test@test.com" },
    ];
    const scrubbed = guard.scrubMessages(messages);
    for (const msg of scrubbed) {
      expect(msg.content).not.toContain("test@test.com");
    }
  });
});
