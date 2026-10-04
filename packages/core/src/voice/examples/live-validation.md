# Opt-in voice validation

Contract tests make no paid requests. `validateLiveRecognition` runs real, paced recognition only after an explicit account/provider/audio-budget gate. The included OpenAI runner takes a caller-supplied corpus of **raw mono PCM16LE at 24 kHz**. It does not synthesize test audio, reuse general application credentials or enable itself in CI.

After building core, create an application-owned manifest:

```json
{
  "cases": [
    { "id": "english-order", "pcmPath": "english.pcm", "languages": ["en"], "scenario": "baseline", "requiredPhrases": ["AC-42"] },
    { "id": "hindi-order", "pcmPath": "hindi.pcm", "languages": ["hi"], "scenario": "baseline", "requiredPhrases": ["ऑर्डर"] },
    { "id": "hindi-english", "pcmPath": "code-switch.pcm", "languages": ["hi", "en"], "scenario": "code-switching", "requiredPhrases": ["order"] },
    { "id": "reconnect", "pcmPath": "english.pcm", "languages": ["en"], "scenario": "reconnect" }
  ]
}
```

Paths resolve relative to the manifest. Use consented test recordings with accents, noise, false starts and domain-specific numbers; add each application's selected languages. Each case opens and closes a connection, so the reconnect case checks a new session after earlier cleanup. This runner does not claim provider-side session resumption.

Explicitly configure the approved account in your shell/secret manager, then run:

```sh
# Set AGENTIUM_VOICE_TEST_OPENAI_API_KEY to the approved test project's key securely.
AGENTIUM_VOICE_LIVE_TEST=1 \
AGENTIUM_VOICE_TEST_ACCOUNT=approved-test-project \
AGENTIUM_VOICE_TEST_MAX_SECONDS=60 \
AGENTIUM_VOICE_TEST_MAX_CASES=10 \
node packages/core/src/voice/examples/validate-openai-recognition.mjs /absolute/path/corpus.json
```

The dedicated key variable is required; there is no fallback to `OPENAI_API_KEY`. This command sends corpus audio to OpenAI and may incur charges. Reports contain transcripts; save them only to an approved location. Missing gate/account/key or a corpus exceeding the approved bound rejects before a provider connection. Ctrl-C cancels the run. No approved account/corpus was available during repository implementation, so **no paid provider result is claimed**.

The report contains committed-input-to-final-transcript p50/p95, detected languages when actually returned, declared audio duration and application phrase checks. Missing phrase criteria produce `taskSuccess:null`. Audio duration is input measurement, not a provider billing statement. The same runner supports ElevenLabs/Sarvam through a matching `createRecognizer` and explicit provider allowlist.

For full conversation evaluation, instrument the real client/player and pass observations to `summarizeVoicePlayback`:

```ts
const report = summarizeVoicePlayback([
  {
    caseId: "hindi-interrupt", languages: ["hi", "en"], scenario: "interruption",
    firstAudibleMs: clientFirstAudibleAt - clientEndOfTurnAt,
    taskSuccess: domainAssertionPassed,
    staleFrames: pipeline.coordinator.staleFrames,
    queueHighWaterBytes: playerQueue.highWaterBytes,
    billing: serverReportedUsage,
  },
]);
```

Both timestamps must use the same client clock. Test baseline, code switching, interruption, reconnect, long tools and selected target languages. Omit measurements you cannot observe: the summary does not replace missing first-audible measurements with first-frame timings, invent successful task outcomes or infer paid usage. A host-owned remote playback fixture is still required to certify audibility, stale-frame rate and cross-device latency. Synthetic/mock fixtures establish contracts only.
