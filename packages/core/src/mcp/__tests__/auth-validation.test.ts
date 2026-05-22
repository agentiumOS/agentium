import { describe, expect, it } from "vitest";
import {
  authorizationServerSupportsIss,
  MCPAuthError,
  needsReRegistration,
  pickOidcApplicationType,
  validateAuthIssuer,
} from "../auth-validation.js";

describe("validateAuthIssuer (RFC 9207 / SEP-2468)", () => {
  it("accepts an exact match", () => {
    expect(() => validateAuthIssuer("https://idp.example.com", "https://idp.example.com")).not.toThrow();
  });

  it("rejects mismatched issuer (mix-up attack)", () => {
    expect(() => validateAuthIssuer("https://evil.example.com", "https://idp.example.com")).toThrow(MCPAuthError);
  });

  it("rejects missing iss when expected", () => {
    expect(() => validateAuthIssuer(undefined, "https://idp.example.com")).toThrow(/missing/);
  });

  it("uses simple string comparison (no normalization)", () => {
    // Trailing slash matters under simple string compare.
    expect(() => validateAuthIssuer("https://idp.example.com/", "https://idp.example.com")).toThrow(MCPAuthError);
  });
});

describe("authorizationServerSupportsIss", () => {
  it("returns true when metadata advertises support", () => {
    expect(authorizationServerSupportsIss({ authorization_response_iss_parameter_supported: true })).toBe(true);
  });

  it("returns false when metadata is missing the flag", () => {
    expect(authorizationServerSupportsIss({})).toBe(false);
    expect(authorizationServerSupportsIss(null)).toBe(false);
    expect(authorizationServerSupportsIss(undefined)).toBe(false);
  });
});

describe("pickOidcApplicationType (SEP-837)", () => {
  it("returns native for localhost-redirect flows", () => {
    expect(pickOidcApplicationType({ usesLocalhostRedirect: true })).toBe("native");
  });

  it("returns web by default", () => {
    expect(pickOidcApplicationType({})).toBe("web");
  });

  it("honors explicit override", () => {
    expect(pickOidcApplicationType({ override: "native", usesLocalhostRedirect: false })).toBe("native");
    expect(pickOidcApplicationType({ override: "web", usesLocalhostRedirect: true })).toBe("web");
  });
});

describe("needsReRegistration (SEP-2352)", () => {
  it("returns true when issuers differ", () => {
    expect(needsReRegistration("https://old.example", "https://new.example")).toBe(true);
  });

  it("returns false when issuers match", () => {
    expect(needsReRegistration("https://x.example", "https://x.example")).toBe(false);
  });

  it("returns true when either issuer is missing", () => {
    expect(needsReRegistration(null, "https://x")).toBe(true);
    expect(needsReRegistration("https://x", null)).toBe(true);
    expect(needsReRegistration(undefined, undefined)).toBe(true);
  });
});
