import type { StealthConfig } from "./types.js";

const REALISTIC_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
];

/** Pick a random realistic user-agent string. */
export function pickUserAgent(): string {
  return REALISTIC_USER_AGENTS[Math.floor(Math.random() * REALISTIC_USER_AGENTS.length)];
}

/**
 * JavaScript that runs inside every page to patch common bot-detection vectors.
 * Injected via Playwright's `context.addInitScript()`.
 */
export function getStealthScript(): string {
  return `
    // ── navigator.webdriver ──────────────────────────────────────────
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // ── navigator.plugins — appear non-empty ─────────────────────────
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
      configurable: true,
    });

    // ── navigator.languages ──────────────────────────────────────────
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });

    // ── navigator.permissions.query — hide "denied" for notifications ─
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return originalQuery(params);
    };

    // ── chrome runtime — make it look like a real Chrome ─────────────
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
      };
    }

    // ── WebGL renderer — mask headless indicators ────────────────────
    const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameterOrig.call(this, param);
    };

    // ── WebGL2 renderer ──────────────────────────────────────────────
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParam2Orig = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        return getParam2Orig.call(this, param);
      };
    }

    // ── Prevent iframe detection of automation ───────────────────────
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      get: function() {
        return window;
      },
    });

    // ── Remove "cdc_" Playwright/ChromeDriver markers from DOM ───────
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            const el = node;
            for (const attr of [...el.attributes]) {
              if (attr.name.startsWith('cdc_') || attr.name.startsWith('__playwright')) {
                el.removeAttribute(attr.name);
              }
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  `;
}

/**
 * Build Playwright context options from a StealthConfig.
 */
export function buildStealthContextOpts(
  config: StealthConfig,
  viewport: { width: number; height: number },
): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    viewport,
    userAgent: config.userAgent ?? pickUserAgent(),
    locale: config.locale ?? "en-US",
    timezoneId: config.timezone ?? "America/New_York",
    colorScheme: "light" as const,
    deviceScaleFactor: 2,
    hasTouch: false,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: config.ignoreHTTPSErrors ?? false,
  };

  if (config.geolocation) {
    opts.geolocation = config.geolocation;
    opts.permissions = ["geolocation"];
  }

  return opts;
}

/**
 * Build Playwright launch options for stealth.
 */
export function buildStealthLaunchArgs(config: StealthConfig): {
  args: string[];
  proxy?: { server: string; username?: string; password?: string };
} {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const proxy = config.proxy
    ? { server: config.proxy.server, username: config.proxy.username, password: config.proxy.password }
    : undefined;

  return { args, proxy };
}
