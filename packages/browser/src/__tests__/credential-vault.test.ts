import { describe, expect, it } from "vitest";
import { CredentialVault } from "../credential-vault.js";

describe("CredentialVault", () => {
  it("stores and retrieves credentials", () => {
    const vault = new CredentialVault();
    vault.set("email", "user@example.com");

    expect(vault.get("email")).toBe("user@example.com");
    expect(vault.has("email")).toBe(true);
  });

  it("keys are case-insensitive", () => {
    const vault = new CredentialVault();
    vault.set("Email", "user@example.com");

    expect(vault.get("email")).toBe("user@example.com");
    expect(vault.get("EMAIL")).toBe("user@example.com");
  });

  it("constructor accepts initial credentials", () => {
    const vault = new CredentialVault({
      email: "a@b.com",
      password: "secret",
    });

    expect(vault.keys()).toEqual(["email", "password"]);
  });

  it("keys() returns placeholder names without values", () => {
    const vault = new CredentialVault({ user: "alice", pass: "123" });
    const keys = vault.keys();

    expect(keys).toContain("user");
    expect(keys).toContain("pass");
    expect(keys).not.toContain("alice");
  });

  it("resolve() replaces placeholders with values", () => {
    const vault = new CredentialVault({
      email: "user@example.com",
      password: "s3cret",
    });

    const resolved = vault.resolve("Login: {{email}} / {{password}}");
    expect(resolved).toBe("Login: user@example.com / s3cret");
  });

  it("resolve() leaves unknown placeholders unchanged", () => {
    const vault = new CredentialVault({ email: "a@b.com" });
    const resolved = vault.resolve("{{email}} and {{unknown}}");
    expect(resolved).toBe("a@b.com and {{unknown}}");
  });

  it("mask() replaces credential values with placeholders", () => {
    const vault = new CredentialVault({
      email: "user@example.com",
      password: "s3cret",
    });

    const masked = vault.mask("Logged in as user@example.com with password s3cret");
    expect(masked).toBe("Logged in as {{email}} with password {{password}}");
  });

  it("mask() handles text without credentials unchanged", () => {
    const vault = new CredentialVault({ key: "value" });
    const text = "No credentials here";
    expect(vault.mask(text)).toBe(text);
  });

  it("fromEnv() loads credentials from environment variables", () => {
    process.env.__TEST_VAULT_EMAIL = "env@example.com";
    const vault = new CredentialVault();
    vault.fromEnv({ email: "__TEST_VAULT_EMAIL" });

    expect(vault.get("email")).toBe("env@example.com");
    delete process.env.__TEST_VAULT_EMAIL;
  });

  it("set() is chainable", () => {
    const vault = new CredentialVault();
    const result = vault.set("a", "1").set("b", "2");
    expect(result).toBe(vault);
    expect(vault.keys()).toEqual(["a", "b"]);
  });
});
