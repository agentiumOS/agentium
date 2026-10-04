export interface VoiceMigrationDiagnostic {
  code: "transcription-model-deprecated" | "tts-snapshot-deprecated" | "prompt-object-deprecated";
  message: string;
  shutdownDate: string;
  source: string;
  verifiedAt: string;
}
/** Informational migration data; it never substitutes an unverified model/API contract. */
export function voiceMigrationDiagnostics(config: {
  transcriptionModel?: string;
  ttsModel?: string;
  remotePrompt?: boolean;
}): VoiceMigrationDiagnostic[] {
  const base = { source: "https://developers.openai.com/api/docs/deprecations", verifiedAt: "2026-10-04" };
  const result: VoiceMigrationDiagnostic[] = [];
  if (
    ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize"].includes(
      config.transcriptionModel ?? "",
    )
  )
    result.push({
      ...base,
      code: "transcription-model-deprecated",
      shutdownDate: "2027-02-26",
      message: `${config.transcriptionModel} is scheduled for removal. Use OpenAIFileTranscriber (gpt-transcribe) for recorded audio or OpenAIStreamingRecognizer for live PCM. Timestamp, subtitle and diarization workflows need a separate migration.`,
    });
  if (["tts-1", "tts-1-hd", "gpt-4o-mini-tts-2025-03-20", "gpt-4o-mini-tts-2025-12-15"].includes(config.ttsModel ?? ""))
    result.push({
      ...base,
      code: "tts-snapshot-deprecated",
      shutdownDate: "2027-01-06",
      message: `${config.ttsModel} is scheduled for removal. A Realtime replacement needs a different integration than the buffered speech endpoint.`,
    });
  if (config.remotePrompt)
    result.push({
      ...base,
      code: "prompt-object-deprecated",
      shutdownDate: "2026-11-30",
      message: "Move reusable prompt content to application-owned instructions.",
    });
  return result;
}
