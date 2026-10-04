/** Opt-in real-provider runner. Run after building core. This file is never imported by the library. */
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenAIStreamingRecognizer, requireVoiceLiveValidation, validateLiveRecognition } from "../../../dist/voice/index.js";
const gate = {
  enabled: process.env.AGENTIUM_VOICE_LIVE_TEST === "1",
  accountLabel: process.env.AGENTIUM_VOICE_TEST_ACCOUNT ?? "",
  allowedProviders: ["openai"],
  maxAudioSeconds: Number(process.env.AGENTIUM_VOICE_TEST_MAX_SECONDS ?? 60),
  maxCases: Number(process.env.AGENTIUM_VOICE_TEST_MAX_CASES ?? 10),
};
// Validate consent before reading corpus files or discovering the API key.
requireVoiceLiveValidation(gate, "openai", 1, 0);
if (!process.argv[2]) throw new Error("Pass a JSON corpus manifest path");
const apiKey = process.env.AGENTIUM_VOICE_TEST_OPENAI_API_KEY;
if (!apiKey) throw new Error("Set the dedicated approved-account AGENTIUM_VOICE_TEST_OPENAI_API_KEY (no fallback to general credentials)");
const manifestPath = resolve(process.argv[2]);
if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error("Corpus manifest exceeds 1 MiB");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.cases) || !manifest.cases.length || manifest.cases.length > gate.maxCases) throw new Error("Invalid corpus case count");
const cases = [];
let totalBytes = 0;
for (const item of manifest.cases) {
  if (!item.id || !Array.isArray(item.languages) || !item.languages.length || !["baseline", "code-switching", "reconnect"].includes(item.scenario)) throw new Error("Each case needs id, languages and supported scenario");
  const path = resolve(dirname(manifestPath), item.pcmPath);
  const info = await stat(path);
  totalBytes += info.size;
  requireVoiceLiveValidation(gate, "openai", manifest.cases.length, totalBytes / 48000);
  if (!info.isFile() || info.size === 0 || info.size % 2) throw new Error("Provide mono PCM16LE at 24 kHz (complete samples)");
  const pcm = await readFile(path);
  if (pcm.subarray(0, 4).toString() === "RIFF") throw new Error("Decode WAV first; pcmPath must contain raw PCM16LE");
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += 960) frames.push({ bytes: pcm.subarray(offset, offset + 960), encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1, sequence: frames.length, generationId: item.id, turnId: item.id });
  cases.push({ id: item.id, languages: item.languages, scenario: item.scenario, requiredPhrases: item.requiredPhrases, frames });
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const report = await validateLiveRecognition({
  gate, provider: "openai", cases, signal: controller.signal,
  createRecognizer: testCase => new OpenAIStreamingRecognizer({ apiKey, languages: testCase.languages }),
});
// Contains transcripts: redirect only to an approved location for this test corpus.
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
