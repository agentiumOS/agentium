import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  fromLiveKitAudioFrame,
  type LiveKitAudioFrame,
  type LiveKitAudioSource,
  LiveKitVoiceTransport,
} from "../livekit-transport.js";

// Local native SDK only: no room connection, credentials or paid network operation.
it.skipIf(!process.env.AGENTIUM_LIVEKIT_SDK_ROOT)(
  "captures and clears frames with the installed native LiveKit RTC SDK",
  async () => {
    const require = createRequire(resolve(process.env.AGENTIUM_LIVEKIT_SDK_ROOT!, "package.json"));
    const sdk = require("@livekit/rtc-node") as {
      AudioFrame: new (
        data: Int16Array,
        sampleRate: number,
        channels: number,
        samplesPerChannel: number,
      ) => LiveKitAudioFrame;
      AudioSource: new (sampleRate: number, channels: number, queueMs: number) => LiveKitAudioSource<LiveKitAudioFrame>;
      dispose(): void;
    };
    const source = new sdk.AudioSource(24000, 1, 100);
    const transport = new LiveKitVoiceTransport({
      source,
      AudioFrame: sdk.AudioFrame,
      inputFormat: { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
      maxQueuedMs: 100,
      ownsSource: true,
    });
    try {
      const audio = fromLiveKitAudioFrame(new sdk.AudioFrame(new Int16Array(480), 24000, 1, 480), {
        sequence: 0,
        generationId: "native",
        turnId: "native",
      });
      await transport.play(audio, new AbortController().signal);
      expect(transport.highWaterQueuedMs).toBe(20);
      await transport.clear("native");
      expect(source.queuedDuration).toBe(0);
    } finally {
      await transport.close();
      sdk.dispose();
    }
  },
);
