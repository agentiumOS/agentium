/** Coverage is evidence-based and independent of whether a price rule is configured. */
export interface AccountingCapability {
  adapter: string;
  status: "supported" | "partial" | "unmetered" | "local";
  evidence: string;
  limitations: string[];
}

/** Named built-in non-model capabilities. Custom adapters must declare their own billing measurements. */
export const BUILTIN_ACCOUNTING_CAPABILITIES: readonly AccountingCapability[] = [
  {
    adapter: "embeddings/openai",
    status: "supported",
    evidence: "Provider prompt_tokens",
    limitations: ["SDK retries are opaque; custom gateways require their own tariff"],
  },
  {
    adapter: "embeddings/google",
    status: "partial",
    evidence: "Provider usage metadata when available",
    limitations: ["Multimodal unit mappings require a contract; missing usage remains unknown"],
  },
  {
    adapter: "embeddings/hash",
    status: "local",
    evidence: "Local computation",
    limitations: ["Infrastructure charges are outside this adapter"],
  },
  {
    adapter: "rerank/cohere",
    status: "supported",
    evidence: "Provider billed search units",
    limitations: ["SDK retries are opaque"],
  },
  { adapter: "rerank/jina", status: "supported", evidence: "Provider total_tokens per HTTP attempt", limitations: [] },
  {
    adapter: "rerank/voyage",
    status: "supported",
    evidence: "Provider total_tokens per HTTP attempt",
    limitations: [],
  },
  {
    adapter: "rerank/cross-encoder",
    status: "local",
    evidence: "Local model execution",
    limitations: ["Infrastructure charges require a custom operation"],
  },
  {
    adapter: "toolkits/image-generation",
    status: "partial",
    evidence: "Returned image count and raw token usage",
    limitations: ["Image/token modalities and successful-image billing contract are not inferred"],
  },
  {
    adapter: "voice/openai-realtime",
    status: "partial",
    evidence: "Response ID, terminal status, raw usage including cache/audio details",
    limitations: [
      "Modality intersections need rules; automatic server turns cannot guarantee per-request budget admission",
    ],
  },
  {
    adapter: "voice/google-live",
    status: "partial",
    evidence: "Live usage metadata",
    limitations: ["Modality and snapshot semantics remain uncovered; automatic server turns are not strictly gated"],
  },
  {
    adapter: "voice/speech",
    status: "partial",
    evidence: "Characters or provider-reported duration where available; raw unknown otherwise",
    limitations: ["Session minimums, accepted text and duration rules require a billing contract"],
  },
  {
    adapter: "voice/file-transcription",
    status: "partial",
    evidence: "Physical request identity and safe raw provider usage",
    limitations: ["Transcription token/duration contract is not inferred from uploaded bytes"],
  },
  {
    adapter: "voice/pipeline",
    status: "partial",
    evidence: "Metered model calls, file transcription usage, and measured speech characters",
    limitations: ["Speech character/duration pricing requires an explicit provider contract"],
  },
  ...[
    "websearch",
    "pageindex",
    "jev",
    "sandbox-e2b",
    "sandbox-daytona",
    "s3",
    "code-interpreter",
    "scraper",
    "http",
  ].map(
    (adapter): AccountingCapability => ({
      adapter: `toolkits/${adapter}`,
      status: "unmetered",
      evidence: "No provider billing evidence is exposed by this toolkit",
      limitations: [
        "Wrap paid operations with meteredOperation and a documented meter; wall time is not a provider bill",
      ],
    }),
  ),
  ...[
    "calendar",
    "discord",
    "duckduckgo",
    "filesystem",
    "git",
    "github",
    "gmail",
    "google-sheets",
    "google-workspace",
    "hackernews",
    "jira",
    "notion",
    "pdf",
    "redis",
    "shell",
    "slack",
    "sql",
    "stripe",
    "telegram",
    "whatsapp",
    "wikipedia",
    "youtube",
  ].map(
    (adapter): AccountingCapability => ({
      adapter: `toolkits/${adapter}`,
      status: "unmetered",
      evidence: "Tool result has no infrastructure/subscription/transaction tariff",
      limitations: ["A successful tool call does not prove a specific external fee"],
    }),
  ),
  { adapter: "toolkits/calculator", status: "local", evidence: "Local arithmetic", limitations: [] },
];
