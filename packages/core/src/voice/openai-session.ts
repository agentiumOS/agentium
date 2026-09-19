import type { AudioFormat, RealtimeSessionConfig, TurnDetectionConfig } from "./types.js";

export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export function audioFormatToGa(fmt?: AudioFormat): { type: string; rate?: number } {
  switch (fmt) {
    case "g711_ulaw":
      return { type: "audio/pcmu" };
    case "g711_alaw":
      return { type: "audio/pcma" };
    default:
      return { type: "audio/pcm", rate: 24000 };
  }
}

export function turnDetectionToGa(
  td: TurnDetectionConfig | null | undefined,
): Record<string, unknown> | null | undefined {
  if (td === undefined) {
    return {
      type: "semantic_vad",
      eagerness: "low",
      create_response: true,
      interrupt_response: true,
    };
  }
  if (td === null) return null;
  if (td.type === "semantic_vad") {
    return {
      type: "semantic_vad",
      ...(td.eagerness ? { eagerness: td.eagerness } : {}),
      create_response: td.createResponse ?? true,
      interrupt_response: td.interruptResponse ?? true,
    };
  }
  return {
    type: "server_vad",
    ...(td.threshold !== undefined ? { threshold: td.threshold } : {}),
    ...(td.prefixPaddingMs !== undefined ? { prefix_padding_ms: td.prefixPaddingMs } : {}),
    ...(td.silenceDurationMs !== undefined ? { silence_duration_ms: td.silenceDurationMs } : {}),
    create_response: td.createResponse ?? true,
    interrupt_response: td.interruptResponse ?? true,
    ...(td.idleTimeoutMs !== undefined ? { idle_timeout_ms: td.idleTimeoutMs } : {}),
  };
}

/** GA `session.update` body (`session.type: "realtime"`). */
export function buildOpenAIRealtimeSession(modelId: string, config: RealtimeSessionConfig): Record<string, unknown> {
  const audio: Record<string, unknown> = {
    input: {
      format: audioFormatToGa(config.inputAudioFormat),
      turn_detection: turnDetectionToGa(config.turnDetection),
      transcription: { model: config.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL },
      ...(config.noiseReduction ? { noise_reduction: { type: config.noiseReduction.type } } : {}),
    },
    output: {
      format: audioFormatToGa(config.outputAudioFormat),
      ...(config.voice ? { voice: config.voice } : {}),
    },
  };

  const session: Record<string, unknown> = {
    type: "realtime",
    model: modelId,
    output_modalities: ["audio"],
    audio,
  };

  if (config.instructions) session.instructions = config.instructions;
  if (config.temperature !== undefined) session.temperature = config.temperature;
  if (config.maxResponseOutputTokens !== undefined) {
    session.max_response_output_tokens = config.maxResponseOutputTokens;
  }
  if (config.reasoningEffort) {
    session.reasoning = { effort: config.reasoningEffort };
  }
  if (config.prompt) {
    session.prompt = {
      id: config.prompt.id,
      ...(config.prompt.version ? { version: config.prompt.version } : {}),
      ...(config.prompt.variables ? { variables: config.prompt.variables } : {}),
    };
  }
  if (config.translation?.targetLanguage) {
    const extra = `Always reply in ${config.translation.targetLanguage}. Translate the user's speech if needed.`;
    session.instructions = session.instructions ? `${session.instructions}\n\n${extra}` : extra;
  }

  const tools: unknown[] = [];
  if (config.tools?.length) {
    for (const t of config.tools) {
      tools.push({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      });
    }
  }
  if (config.mcpServers?.length) {
    for (const m of config.mcpServers) {
      tools.push({
        type: "mcp",
        server_label: m.serverLabel,
        server_url: m.serverUrl,
        ...(m.headers ? { headers: m.headers } : {}),
      });
    }
  }
  if (tools.length) session.tools = tools;

  return session;
}
