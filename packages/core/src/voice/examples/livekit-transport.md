# LiveKit RTC transport

`LiveKitVoiceTransport` is an executable media adapter for the Node RTC SDK. It accepts the real `AudioSource` and `AudioFrame` constructor without importing an optional SDK into core. Install `@livekit/rtc-node` in your host. Version **1.1.0** was locally tested on 4 October 2026 with native frame capture, clearing and cleanup; no room/token or remote playback was used in that test.

```ts
import { AudioFrame as RTCAudioFrame, AudioSource, AudioStream, LocalAudioTrack } from "@livekit/rtc-node";
import {
  AgentVoiceBrain, StreamingVoicePipeline, OpenAIStreamingRecognizer,
  ElevenLabsSynthesizer, LiveKitVoiceTransport, fromLiveKitAudioFrame,
} from "@agentium/core/voice";

// The host authenticates room/participant identity and connects the Room first.
const source = new AudioSource(24000, 1, 1000);
const localTrack = LocalAudioTrack.createAudioTrack("agentium-voice", source);
await room.localParticipant!.publishTrack(localTrack);
const transport = new LiveKitVoiceTransport({
  source, AudioFrame: RTCAudioFrame,
  inputFormat: { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
  maxQueuedMs: 1000, maxPendingFrames: 32,
});
const pipeline = new StreamingVoicePipeline({
  recognizer: new OpenAIStreamingRecognizer({ languages: ["hi", "en"] }),
  synthesizer: new ElevenLabsSynthesizer({ voiceId: approvedVoiceId }),
  brain: new AgentVoiceBrain(agent, { tenantId, userId }),
  transport,
});
// Use only the remote audio track selected by the authenticated host.
const incoming = new AudioStream(remoteTrack, 24000, 1);
const reader = incoming.getReader();
await pipeline.open();
let sequence = 0;
try {
  while (!shutdownSignal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    await pipeline.sendAudio(fromLiveKitAudioFrame(value, {
      sequence: sequence++, turnId: "input", generationId: inputGenerationId,
    }));
    // Your client-side VAD calls pipeline.flushInput() at each end-of-turn.
  }
} finally {
  await reader.cancel();
  reader.releaseLock();
  await pipeline.close();
  await transport.close(); // Default ownership leaves source/room with the host.
  await source.close();
  // Host also unpublishes the track and closes its room when appropriate.
}
```

Tie `shutdownSignal` to `reader.cancel()` as well so a stalled read wakes on shutdown. `AudioStream` requests the desired input rate; `fromLiveKitAudioFrame` validates metadata and copies signed samples to PCM16LE. The output adapter requires mono PCM16 at the source's exact sample rate; it performs no codec conversion. The host must exclusively dedicate the source to this transport.

Native capture is serialized and bounded by pending frame count and queued **milliseconds**. A capture exceeding `captureTimeoutMs` (10 seconds by default) fails and closes the adapter to further frames; recreate the transport instead of overlapping a stalled native capture. Generation changes clear old output, and a clear/abort racing an in-flight capture is fenced before the next capture. `highWaterQueuedMs` measures the local source queue. `ownsSource:true` transfers source cleanup to `transport.close()`; otherwise the host owns it. The global SDK `dispose()` is process-wide: call it only when the entire host has finished using LiveKit, never per active room.

`playbackAcknowledgements` is false: native queue drain, publication and server receipt do not prove remote audibility. Feed actual client timing into `summarizeVoicePlayback`; do not treat `AudioSource.waitForPlayout()` as a heard-text acknowledgement. Room negotiation, permissions, remote audio and end-to-end p50/p95 require the host's live test room.

Do not also start a LiveKit `AgentSession` tool/model loop for these turns. Recognition and synthesis are media ports; `AgentVoiceBrain` delegates once to the existing Agent runtime.

Run the opt-in local native regression against your installed SDK without network or credentials:

```sh
AGENTIUM_LIVEKIT_SDK_ROOT=/absolute/path/to/host-project npx vitest run packages/core/src/voice/__tests__/livekit-native.integration.test.ts
```

References: [AudioSource](https://docs.livekit.io/reference/client-sdk-node/classes/AudioSource.html), [AudioStream](https://docs.livekit.io/reference/client-sdk-node/classes/AudioStream.html), [official AudioSource implementation and queue units](https://github.com/livekit/node-sdks/blob/main/packages/livekit-rtc/src/audio_source.ts).
