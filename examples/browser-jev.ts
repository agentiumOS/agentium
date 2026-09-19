/**
 * BrowserAgent + Jev planner — each step is a TypeSafe choice over this
 * frame's controls (click_12, type_3, back, done, …). Playwright clicks.
 *
 * Do not set model: jev() — Jev cannot see screenshots. The cheap text
 * model only invents type/search strings.
 *
 *   TYPESAFE_API_KEY=... OPENAI_API_KEY=... npx tsx examples/browser-jev.ts
 */

import { BrowserAgent } from "@agentium/browser";
import { openai } from "@agentium/core";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("Set TYPESAFE_API_KEY first (export it or add it to .env).");
  process.exit(1);
}

const browser = new BrowserAgent({
  name: "jev-browser",
  model: openai("gpt-4o-mini"),
  planner: "jev",
  jevModel: "jev-latest",
  searchEngine: "bing",
  headless: false,
  stealth: true,
  useVision: false,
  maxSteps: 12,
  logLevel: "info",
});

browser.eventBus.on("browser.action", ({ action }: { action: unknown }) => {
  console.log(`  → ${JSON.stringify(action)}`);
});

const result = await browser.run(
  'Search Bing for "TypeScript agent framework" and return the first 3 titles',
);

console.log("\nSuccess:", result.success);
console.log("Steps:", result.steps.length);
console.log("Final URL:", result.finalUrl);
console.log("\nResult:");
console.log(result.result);
