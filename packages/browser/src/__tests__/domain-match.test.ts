import { describe, expect, it } from "vitest";

// Re-implemented test-only mirror of the matcher in `browser-agent.ts`.
// Keeping a tiny copy here lets us test the wildcard semantics in isolation
// without spinning up a BrowserAgent (which needs Playwright).
function matchDomain(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  let p = pattern
    .toLowerCase()
    .replace(/^https?\*?:\/\//, "")
    .replace(/^\/+/, "");
  if (p.includes("/")) p = p.split("/")[0];
  if (p === "*") return true;
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return false;
}

describe("matchDomain", () => {
  it("matches exact host", () => {
    expect(matchDomain("example.com", "example.com")).toBe(true);
    expect(matchDomain("evil.com", "example.com")).toBe(false);
  });

  it("matches wildcard subdomain (including bare)", () => {
    expect(matchDomain("example.com", "*.example.com")).toBe(true);
    expect(matchDomain("a.example.com", "*.example.com")).toBe(true);
    expect(matchDomain("a.b.example.com", "*.example.com")).toBe(true);
    expect(matchDomain("notexample.com", "*.example.com")).toBe(false);
  });

  it("strips http(s) and trailing paths from patterns", () => {
    expect(matchDomain("example.com", "https://example.com")).toBe(true);
    expect(matchDomain("example.com", "http*://example.com/some/path")).toBe(true);
  });

  it("supports universal *", () => {
    expect(matchDomain("anything.tld", "*")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchDomain("EXAMPLE.COM", "example.com")).toBe(true);
    expect(matchDomain("example.com", "EXAMPLE.COM")).toBe(true);
  });
});
