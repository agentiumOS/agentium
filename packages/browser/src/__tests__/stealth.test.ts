import { describe, expect, it } from "vitest";
import { buildStealthContextOpts, buildStealthLaunchArgs, getStealthScript, pickUserAgent } from "../stealth.js";

describe("pickUserAgent", () => {
  it("returns a non-empty string", () => {
    const ua = pickUserAgent();
    expect(typeof ua).toBe("string");
    expect(ua.length).toBeGreaterThan(0);
  });

  it("returns a Chrome or Safari user agent", () => {
    const ua = pickUserAgent();
    expect(ua).toMatch(/Chrome|Safari/);
  });
});

describe("getStealthScript", () => {
  it("returns a JavaScript string", () => {
    const script = getStealthScript();
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(100);
  });

  it("patches navigator.webdriver", () => {
    const script = getStealthScript();
    expect(script).toContain("navigator");
    expect(script).toContain("webdriver");
  });

  it("patches WebGL renderer", () => {
    const script = getStealthScript();
    expect(script).toContain("WebGLRenderingContext");
  });

  it("removes cdc_ markers", () => {
    const script = getStealthScript();
    expect(script).toContain("cdc_");
  });
});

describe("buildStealthContextOpts", () => {
  it("returns viewport and userAgent", () => {
    const opts = buildStealthContextOpts({}, { width: 1920, height: 1080 });
    expect(opts.viewport).toEqual({ width: 1920, height: 1080 });
    expect(typeof opts.userAgent).toBe("string");
  });

  it("uses custom userAgent when provided", () => {
    const opts = buildStealthContextOpts({ userAgent: "Custom/1.0" }, { width: 1280, height: 720 });
    expect(opts.userAgent).toBe("Custom/1.0");
  });

  it("includes geolocation when provided", () => {
    const opts = buildStealthContextOpts(
      { geolocation: { latitude: 40.7, longitude: -74.0 } },
      { width: 1280, height: 720 },
    );
    expect(opts.geolocation).toEqual({ latitude: 40.7, longitude: -74.0 });
    expect(opts.permissions).toEqual(["geolocation"]);
  });
});

describe("buildStealthLaunchArgs", () => {
  it("returns args array with automation-disabled flag", () => {
    const { args } = buildStealthLaunchArgs({});
    expect(args).toContain("--disable-blink-features=AutomationControlled");
  });

  it("includes proxy when provided", () => {
    const { proxy } = buildStealthLaunchArgs({
      proxy: { server: "http://proxy:8080", username: "u", password: "p" },
    });
    expect(proxy).toEqual({
      server: "http://proxy:8080",
      username: "u",
      password: "p",
    });
  });

  it("returns undefined proxy when not provided", () => {
    const { proxy } = buildStealthLaunchArgs({});
    expect(proxy).toBeUndefined();
  });
});
