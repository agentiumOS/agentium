/** Context for the current GPT transcription models, not conversation instructions. */
export interface OpenAITranscriptionContext {
  prompt?: string;
  keywords?: readonly string[];
  languages?: readonly string[];
}
export const DEFAULT_FILE_TRANSCRIPTION_MODEL = "gpt-transcribe";
export const DEFAULT_LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export function transcriptionContext(context: OpenAITranscriptionContext): Record<string, unknown> {
  if (context.prompt !== undefined && (typeof context.prompt !== "string" || context.prompt.length > 16_384))
    throw new Error("Transcription prompt exceeds the adapter context bound");
  for (const [name, values] of [
    ["keywords", context.keywords],
    ["languages", context.languages],
  ] as const) {
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.length > 128 ||
        values.some((value) => typeof value !== "string" || !value || value.length > 256))
    )
      throw new Error(`Invalid transcription ${name}`);
  }
  if (context.keywords?.some((value) => /[<>\r\n]/.test(value)))
    throw new Error("Transcription keywords must be literal single-line terms without angle brackets");
  return {
    ...(context.prompt !== undefined ? { prompt: context.prompt } : {}),
    ...(context.keywords?.length ? { keywords: [...context.keywords] } : {}),
    ...(context.languages?.length ? { languages: [...context.languages] } : {}),
  };
}
export function detectedLanguages(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.code !== "string"))
    throw new Error("Invalid detected-language transcription response");
  return value.map((item) => item.code);
}
export interface OpenAIFileTranscriberOptions extends OpenAITranscriptionContext {
  apiKey?: string;
  /** API origin, optionally ending in /v1. Custom endpoints are explicitly host-trusted. */
  baseURL?: string;
  model?: string;
  fetch?: typeof fetch;
  maxAudioBytes?: number;
  timeoutMs?: number;
}
export interface FileTranscription {
  text: string;
  /** Detected languages, never copied from hints. [] means the provider made no prediction. */
  languages?: string[];
}
const extensions: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "video/webm": "webm",
};
/** Completed-file JSON transcription. No timestamp, subtitle, translation or diarization claims. */
export class OpenAIFileTranscriber {
  private options: OpenAIFileTranscriberOptions;
  constructor(options: OpenAIFileTranscriberOptions = {}) {
    this.options = { ...options, ...transcriptionContext(options) };
    for (const [name, value] of [
      ["maxAudioBytes", options.maxAudioBytes],
      ["timeoutMs", options.timeoutMs],
    ] as const)
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid ${name}`);
    if ((options.maxAudioBytes ?? 0) > 25_000_000) throw new Error("File transcription supports at most 25 MB");
    if (options.model === "gpt-live-transcribe")
      throw new Error("gpt-live-transcribe requires a Realtime transcription session");
    if (
      options.model &&
      options.model !== DEFAULT_FILE_TRANSCRIPTION_MODEL &&
      (options.languages?.length || options.keywords?.length)
    )
      throw new Error("languages/keywords context is supported here only for gpt-transcribe");
  }
  async transcribe(audio: Uint8Array, mimeType = "audio/wav", signal?: AbortSignal): Promise<FileTranscription> {
    signal?.throwIfAborted();
    if (
      !(audio instanceof Uint8Array) ||
      audio.byteLength === 0 ||
      audio.byteLength > (this.options.maxAudioBytes ?? 25_000_000)
    )
      throw new Error("Transcription audio is empty or exceeds the upload bound");
    const extension = extensions[mimeType];
    if (!extension) throw new Error("Unsupported transcription MIME type; convert the audio explicitly");
    const key = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is required for file transcription");
    const form = new FormData();
    form.set("model", this.options.model ?? DEFAULT_FILE_TRANSCRIPTION_MODEL);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `audio.${extension}`);
    for (const [name, value] of Object.entries(transcriptionContext(this.options))) {
      if (Array.isArray(value)) for (const entry of value) form.append(`${name}[]`, entry);
      else form.set(name, value as string);
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const root = (this.options.baseURL ?? "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
    const response = await (this.options.fetch ?? fetch)(`${root}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: requestSignal,
      redirect: "error",
    });
    const json = (await response.json()) as { text?: unknown; languages?: unknown; error?: { message?: string } };
    requestSignal.throwIfAborted();
    if (!response.ok) throw new Error(json.error?.message ?? `Transcription failed (${response.status})`);
    if (typeof json.text !== "string") throw new Error("Transcription response lacks text");
    const languages = detectedLanguages(json.languages);
    return { text: json.text, ...(languages !== undefined ? { languages } : {}) };
  }
}
