# Voice and live sessions

Import voice integrations from `@agentium/core/voice`. The native `VoiceAgent` supports OpenAI Realtime and Gemini Live. `StreamingVoicePipeline` lets a recognizer, an ordinary Agent, a synthesizer, and a media transport vary independently. `VoicePipeline` remains the buffered file-transcription → single model call → buffered speech compatibility API; it does not run an Agent tool loop.

## Streaming Agent recipe

```ts
import { Agent, openai } from "@agentium/core";
import {
  AgentVoiceBrain, StreamingVoicePipeline,
  SarvamRecognizer, ElevenLabsSynthesizer,
  type VoiceTransport,
} from "@agentium/core/voice";

// Host-owned tools retain their normal approvals, execution policy and scopes.
const agent = new Agent({
  name: "support", model: openai("gpt-6-sol"), tools: supportTools,
  approval: { policy: "all", onApproval: approveInYourApplication },
  executionPolicy: hostPolicy,
});
const pipeline = new StreamingVoicePipeline({
  recognizer: new SarvamRecognizer(),
  synthesizer: new ElevenLabsSynthesizer({ voiceId: approvedVoiceId }),
  brain: new AgentVoiceBrain(agent, { tenantId, userId }),
  transport: mediaTransport satisfies VoiceTransport,
  language: "hi-IN",
});
await pipeline.open();
// Supply negotiated AudioFrame values with monotonic sequence numbers.
await pipeline.sendAudio(frame);
await pipeline.flushInput();
// Route trusted playback offsets/completion from the media client.
pipeline.acknowledgePlayback({ generationId, playedCharacters: 12 });
await pipeline.close();
```

`@agentium/harness` owns harness composition and execution through its separate `HarnessRuntime`/Agent driver. Core Agent does not accept a `harness` option. `AgentVoiceBrain` continues to take an ordinary Agent and does not introduce another runtime or tool loop.

`AgentVoiceBrain` supplies the coordinator's canonical history through `RunOpts.history` and `ephemeral:true`. It skips Agent-owned session loading/persistence and automatic memory extraction, so repeated voice turns cannot accumulate another copy of the conversation. Configure the wrapped Agent without automatic memory. Explicit memory tools remain host capabilities if deliberately registered. Tool approvals, policy, tenant/user identity, dependency scope and abort propagation use the normal Agent path. Only public text chunks reach speech; reasoning and tool payloads are excluded.

The recognizer emits replacement partials and a final segment with the same ID. The coordinator commits each final once. Beginning a new utterance aborts the previous brain and synthesis generation. Late frames carry the old generation ID and are discarded. Speech sockets have bounded incoming queues and outgoing buffers; overflow terminates with `VoiceBackpressureError`. Supported codecs/rates must match the transport exactly. Resampling, channel mixing and container decoding are explicit host operations.

For custom recognizers, supply stable unique segment IDs within a session. Vendor ports use monotonically numbered committed segments; they do not reconnect silently or replay audio after a socket failure. Create a new input generation when reconnecting. Pipeline sessions hold at most 200 history messages/turn records, 1,024 transcript deduplication entries and 64,000 generated characters per turn. Frames default to a 256 KiB input bound, provider receive queues to 1 MiB, and turns to 60 seconds. A provider that ignores abort may continue upstream work; its late output cannot regain the active generation.

## Generated speech and heard history

`TurnCoordinator.records` keeps generated text and playback-confirmed text separately. `getHistory()` contains the confirmed prefix plus a delivery-unknown marker if playback was interrupted or unacknowledged. A complete acknowledgement is accepted only after `generation_end`. Without playback acknowledgements, generated output is marked unknown, including disconnection after generation but before playback. Offsets count JavaScript string characters and must come from a playback/timing alignment source; receiving a network packet is not evidence that it was heard.

Native `VoiceSession.getTranscript()` uses the same conservative projection. Interrupted generations ignore late playback acknowledgements. `acknowledgePlayback({generationId, playedCharacters})` updates it; `complete:true` confirms the final transcript. The native provider still owns its live server conversation: local acknowledgements do not rewrite or truncate that provider-side history. Use the composable Agent path when playback-confirmed context ownership is required. Native recording remains opt-in and is bounded to 16 MiB per session; use an application recording sink for longer calls.

## Provider contracts

| Adapter | Implemented contract | Explicit limits |
| --- | --- | --- |
| OpenAI | GA nested audio session, `gpt-realtime-2.1`, PCM24k/G.711, transcript identity, async tools, input commit, usage | `temperature` and remote prompt objects reject before connection. One client continuation follows all tool results and `response.done`. Legacy speak-before options no longer launch competing responses. |
| OpenAI file STT | `gpt-transcribe`, completed files up to 25 MB, JSON text/detected languages, plural language/keyword context | Cancellation, request timeout and MIME validation. No subtitles, timestamps, diarization or translation guarantees. |
| OpenAI live STT | `gpt-live-transcribe` (or committed-turn `gpt-transcribe`), WebSocket, PCM24k, manual commit, item-ID reconciliation | Host owns VAD; setup waits for acknowledgement. Pending turns/text and deadlines are bounded. Detected languages are preserved only when returned. |
| Gemini | `gemini-3.8-live`, PCM16k input/24k output, manual or automatic activity, name+ID tool replies, mixed content, input/output transcription, usage, GoAway/resume notices | Tool replies let the provider continue. Manual interruption suppresses local playback; no server cancellation promise. Optional recovery uses safe idle session checkpoints; active input/generation and uncertain tool effects invalidate them. Unsupported OpenAI-only settings reject. |
| ElevenLabs STT | `scribe_v2_realtime`, mono PCM8/16/22.05/24/44.1/48k, manual commit, partial/final segments | Timestamp companion commits do not duplicate history. Application chooses language; service validates provider language availability. |
| ElevenLabs TTS | Standard `stream-input`, flash/turbo v2.5 or multilingual v2, mono PCM16/22.05/24/44.1k, short-text flush | v3/v4 are rejected for this endpoint. Each generation has a new socket. Voice access is validated by the service. |
| Sarvam STT | `saaras:v3-realtime` or `saaras:v4`, manual endpointing, supported Indic/English codes, PCM/G.711 at 8/16k | Advertised maturity is preview because official realtime documentation differs on maturity. Reported session-end usage is seconds. |
| Sarvam TTS | `bulbul:v2/v3`, explicit language/speaker, raw PCM8/16/22.05/24k, completion events | No generic server clear/cancel. Close old socket, clear local playback, suppress late frames; cancellation does not roll back billing. Higher sample rates are REST-only. |

Native `VoiceAgent` automatic memory is configured per Agent instance. A memory-enabled instance binds to the first connection's tenant and user before asynchronous work; subsequent mismatches, including concurrent attempts and anonymous/authenticated changes, fail before connection memory or provider access. Same-owner reconnects remain supported. An explicit `memory.tenantId` also rejects a conflicting first connection. Use separate instances **and host-scoped backing storage** per tenant/user, with trusted session IDs: this guard does not partition storage shared between instances. Use `AgentVoiceBrain` for coordinator-owned ephemeral history.

Native remote MCP is provider-executed and cannot be intercepted by local tool policy. VoiceAgent rejects combining native remote MCP with local policy/approval settings; expose MCP functions as normal local tools for shared enforcement.

Optional socket adapters lazily load `ws`, or accept `socketFactory(url, headers, signal)`. Importing core/voice loads no optional speech SDK and performs no network operations. Keys come from explicit server configuration or `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ELEVENLABS_API_KEY`, and `SARVAM_API_KEY`. No credentials belong in browser audio events.

## Optional native session recovery

Recovery is disabled unless `VoiceAgentConfig.recovery` is supplied:

```ts
const voice = new VoiceAgent({
  name: "support",
  provider: new GoogleLiveProvider(),
  tools: supportTools,
  recovery: {
    maxAttempts: 3,           // total reconnect attempts across this call
    initialDelayMs: 250,     // exponential delay, capped by maxDelayMs
    maxDelayMs: 2_000,
    connectTimeoutMs: 10_000,
    maxElapsedMs: 30_000,    // deadline for each recovery incident
    fallback: "stop",       // choose "fresh" explicitly to allow context loss
  },
});
const session = await voice.connect({ tenantId, userId, signal });
session.on("recovery", (state) => {
  // Pause capture while recovering; clear queued playback on `interrupted`.
  // After `recovered`, obtain new user input. Show loss of context for `fresh`.
  // `failed` ends the session: reconcile effects before starting another call.
  updateCallUI(state);
});
```

Gemini advertises `capabilities.recovery: "session-resumption"` and enables the official `sessionResumption` setup field. An idle, resumable handle remains private to the original connection's owner, provider/model and copied configuration. New input, generation, tool dispatch, interruption or a nonresumable update invalidates it. A GoAway rotates proactively only when a safe checkpoint is available; otherwise the connection continues until it can checkpoint or disconnects. Handles older than two hours are discarded. Recovery does not buffer inputs for transparent replay and does not transfer handles between users, sessions, agents or processes. Hosts using low-level `RealtimeSessionConfig.sessionResumption` directly must scope the supplied handle themselves.

OpenAI native WebSocket sessions advertise `capabilities.recovery: "fresh"`. With explicit `fallback:"fresh"`, reconnect creates a new configured session and waits for `session.updated`. It preserves instructions/tools/settings but **does not preserve provider conversation history**. `fallback:"stop"` ends an OpenAI session on disconnect. No portable OpenAI resume-token contract is invented, and conversation items or unacknowledged tool results are never reconstructed and resent. The existing warm-transfer transcript API is a separate, host-controlled operation.

The stable VoiceSession emits `recovery` with `recovering`, `recovered` or `failed`, an attempt count, continuity (`session-resumption` or `fresh`) and `requiresInput`. Inputs submitted while disconnected/recovering throw; applications should pause capture or discard those frames explicitly. Retry exhaustion, cancellation and session closure cancel pending attempts, and late successful connects are closed. Successful recovery does not emit a terminal `disconnected`; terminal failure or explicit close persists the transcript once.

Recovery emits `interrupted` to invalidate playback acknowledgements and cancel local tool dispatch, detaches the retired transport, and namespaces generation IDs per connection. A replacement connection forwards no generated speech/transcripts/tools until new user input; any generation already started before that input stays suppressed until it ends. Previously seen tool IDs remain deduplicated. An in-flight tool or a sent tool result without a safe completion checkpoint prevents automatic recovery, even with fresh fallback: cancellation cannot prove an external effect did not happen. OpenAI has no resumable effect checkpoint in this adapter, so any local tool work in that session requires host reconciliation before a fresh restart. Managed recovery rejects native remote MCP tools because their effects are not observable locally. Host reconciliation and application idempotency remain necessary; this is not a universal exactly-once guarantee. Raw handles are omitted from the managed session's `session_resume` event, and recovery does not weaken the memory tenant/user binding above.

These contracts were checked against [Gemini session management](https://ai.google.dev/gemini-api/docs/live-api/session-management), the installed `@google/genai` session-resumption types, and [OpenAI realtime conversation lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations). Deterministic native fixtures and a local OpenAI WebSocket acknowledgement/error server cover recovery; paid-provider resumption, long calls and network-dependent speech quality remain live validation work.

## Realtime HTTP helpers

`createRealtimeCall({sdp, apiKey, signal})` creates a WebRTC call using multipart form data and returns `{id, sdp, raw}`. The `sdp` is the answer; `id` comes from the response Location header. It rejects the legacy `sipUri` option because the Realtime create-call endpoint does not place outbound SIP calls. `createRealtimeClientSecret` accepts cancellation and validates that a successful response actually contains a secret. Both refuse redirects. These helpers target Realtime; they do not implement the separate OpenAI Live API lifecycle. See the official [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc) and [SIP guide](https://developers.openai.com/api/docs/guides/voice-sip).

## ElevenLabs Speech Engine

The optional `createElevenLabsSpeechEngineHandler(brain)` callback fits the official SDK's `onTranscript(transcript, signal, session)` contract:

```ts
const onTranscript = createElevenLabsSpeechEngineHandler(brain);
engine.attach(server, "/voice", { onTranscript });
```

The host installs/configures the official SDK and keeps its authentication enabled. Speech Engine owns turn-taking and authoritative conversation history; the callback forwards that history once, propagates its AbortSignal, and emits public `response.output_text.delta` chunks through `session.sendResponse`. It does not start a second recognizer or duplicate the transcript in Agent memory.

## Socket.IO migration

`createVoiceGateway` reserves a session before asynchronous connection, cancels late connects on disconnect, limits frames to 256 KiB and pending output to 1 MiB by default. Output must be acknowledged within 10 seconds (all configurable). With `authMiddleware`, populate `socket.data.auth = {userId, tenantId?, sessionId?}`. Client user/session/API-key overrides are ignored; missing authenticated identity rejects setup.

- `voice.started` advertises input/output formats and acknowledgement support.
- `voice.audio` output includes `sequence`, `generationId`, format, and base64 bytes.
- Send `voice.playback.ack {sequence}` after consuming each frame to release its buffer budget. Include played text offsets only when backed by audio/text alignment.
- After `voice.turn_complete` and actual playback completion, send `voice.playback.complete {generationId}` even if every frame has already been acknowledged.
- `voice.clear` means remove queued playback immediately; do not acknowledge discarded speech as played.
- `voice.recovery` forwards native recovery state. While recovering, incoming audio and commits are discarded; text receives a retryable error without closing the call. After `recovered`, send new input; no frames or text are replayed.
- `voice.commit` flushes manual input. Malformed audio, overflow or stalled acknowledgements close the session.

## Measurement and validation

`pipeline.timings` captures final transcript → first public text, first frame offered to transport, and generation duration. `summarizeVoiceTimings()` produces p50/p95 with sample counts. First-frame delivery is not first-audible latency: record client playback timestamps for that measurement. `coordinator.staleFrames`, `BoundedVoiceQueue.highWaterBytes`, and adapter `onUsage` callbacks expose independent observations. Synthesizer character usage counts submitted characters, not authoritative billed cost; Sarvam's session-end duration is server reported. Unknown price remains unknown.

The checked-in fixtures cover native tool concurrency, interruption, mixed Gemini messages, replacement transcripts, short flushes, English/Hindi/Tamil and code switching, queue overflow, stale frames, playback projection and gateway disconnect races. These are contract tests, not acoustic noise/accuracy evaluations or paid-provider latency benchmarks. No live paid account, browser microphone, PSTN or region/network performance was tested. Run an application evaluation corpus with noise, false starts, long tools, reconnects and long sessions before asserting real p50/p95 latency or task success.

`LiveKitVoiceTransport` accepts actual host-owned RTC sources/constructors; [the executable recipe](examples/livekit-transport.md) replaces the earlier transport spike. Native `@livekit/rtc-node@1.1.0` capture/clear/cleanup passed locally, while room negotiation and remote playback remain untested. [Opt-in live validation](examples/live-validation.md) provides a gated corpus runner and honest first-audible/usage reporting. LiveKit remains optional. Deepgram/Cartesia can implement the same ports. Hosted orchestration frameworks and SIP provisioning remain outside this package.

## Verified migrations and references

Contracts and dates were reviewed against official documentation on 4 October 2026. `voiceMigrationDiagnostics()` and the batch pipeline's `migrationDiagnostics` expose migration notices. The buffered `VoicePipeline` and native OpenAI WebSocket input transcription now default to `gpt-transcribe`, backed by recorded-file and nested Realtime contract fixtures. Explicit legacy model overrides remain possible and produce migration diagnostics. `transcriptionContext` supplies application-owned language/keyword hints; remote prompt objects remain rejected. This is an observable model-default migration: pin an explicit legacy model temporarily if a production audio corpus has not yet been evaluated. The HTTP WebRTC helpers do not configure input transcription; committed-turn `gpt-transcribe` is documented for WebSocket.

- OpenAI reusable prompt objects are scheduled to shut down **30 November 2026**. `whisper-1` and the named 4o transcription family are scheduled for **26 February 2027**. Listed dated mini-TTS snapshots/tts-1 variants are scheduled for **6 January 2027**; the notice does not establish removal of the undated `gpt-4o-mini-tts` alias. [Deprecations](https://developers.openai.com/api/docs/deprecations), [GA Realtime](https://developers.openai.com/api/docs/guides/realtime).
- Current transcription replacement contracts: [overview](https://developers.openai.com/api/docs/guides/transcription), [file upload migration](https://developers.openai.com/cookbook/examples/migrating_from_whisper_to_gpt_transcribe), [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription). New models use `languages`, not singular `language`; `gpt-live-transcribe` has no server VAD.
- Gemini activity/tool/transcription contracts and current stable model: [Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities).
- ElevenLabs: [Scribe events](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference), [stream-input](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts), [Speech Engine JavaScript](https://elevenlabs.io/docs/eleven-api/resources/libraries/speech-engine/javascript-sdk-reference).
- Sarvam: [realtime STT](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming), [streaming TTS](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket), [sample-rate limits](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/how-to/set-the-sample-rate).


## Removed realtime prompt fields

`VoiceAgentConfig.prompt`, `RealtimeSessionConfig.prompt`, and the unused `RealtimePrompt` type have been removed. Resolve reusable prompt content in the application and pass `instructions` to the voice agent/session. JavaScript callers using a legacy prompt field receive a migration error before memory/skill initialization or provider connection. This does not remove the supported transcription-context `prompt` string, which supplies recognition hints rather than a remote realtime prompt object.
