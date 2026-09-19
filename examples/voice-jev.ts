/**
 * Voice + Jev browser — speak a task, Jev picks the clicks, you hear the result.
 *
 *   OPENAI_API_KEY=... TYPESAFE_API_KEY=... npx tsx examples/voice-jev.ts
 *
 * Do not set VoiceAgent.provider to jev() — Jev cannot hear or speak.
 */

import { BrowserAgent } from "@agentium/browser";
import { VoiceAgent, openai, openaiRealtime } from "@agentium/core";

if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY.");
  process.exit(1);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error("Set TYPESAFE_API_KEY.");
  process.exit(1);
}

const browser = new BrowserAgent({
  name: "hands",
  model: openai("gpt-4o-mini"),
  planner: "jev",
  searchEngine: "bing",
  headless: false,
  stealth: true,
  maxSteps: 12,
});

const voice = new VoiceAgent({
  name: "assistant",
  provider: openaiRealtime("gpt-realtime-2.1"),
  voice: "marin",
  turnDetection: { type: "semantic_vad", eagerness: "low" },
  reasoningEffort: "low",
  toolCallBehavior: "speakBeforeAndAfter",
  bargeIn: "always",
  instructions:
    "You talk to the user. When they want something on the web, call browse_web. Then read the result in one short sentence.",
  tools: [browser.asTool()],
  logLevel: "info",
});

const session = await voice.connect();

session.on("transcript", ({ role, text }) => {
  process.stdout.write(`[${role}] ${text}`);
});
session.on("tool_call_start", ({ name }) => {
  console.log(`\n  (tool ${name}…)`);
});

console.log("Voice + Jev browser connected. sendText a task, or pipe mic PCM to session.sendAudio.");
console.log('Demo: sending "Search Bing for TypeScript agent framework and tell me the top 3 titles"\n');

session.sendText("Search Bing for TypeScript agent framework and tell me the top 3 titles");

session.on("tool_result", ({ result }) => {
  console.log("\n\nBrowse result:\n", result);
});
