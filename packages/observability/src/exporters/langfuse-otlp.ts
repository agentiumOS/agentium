import type { Span, Trace } from "../types.js";
import { endpointURL } from "./http.js";
import { OTelExporter, type OTelExporterConfig } from "./otel.js";
export interface LangfuseOTLPExporterConfig
  extends Omit<OTelExporterConfig, "endpoint" | "tracesEndpoint" | "protocol"> {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
}
/** Current Langfuse ingestion. Legacy LangfuseExporter remains a separate compatibility choice. */
export class LangfuseOTLPExporter extends OTelExporter {
  override name = "langfuse-otlp";
  constructor(config: LangfuseOTLPExporterConfig = {}) {
    const publicKey = config.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = config.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) throw new Error("LangfuseOTLPExporter requires project credentials");
    super({
      ...config,
      tracesEndpoint: `${endpointURL(config.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com")}/api/public/otel/v1/traces`,
      headers: {
        ...config.headers,
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
    });
  }
  protected override attributes(span: Span, trace: Trace) {
    const attributes = super.attributes(span, trace);
    attributes["langfuse.observation.type"] =
      span.kind === "llm" ? "generation" : span.kind === "agent" ? "agent" : span.kind === "tool" ? "tool" : "span";
    for (const [source, target] of [
      ["agentName", "langfuse.trace.name"],
      ["sessionId", "langfuse.session.id"],
      ["userId", "langfuse.user.id"],
      ["tenantId", "langfuse.trace.metadata.tenantId"],
      ["rootRunId", "langfuse.trace.metadata.rootRunId"],
    ])
      if (trace.metadata[source] !== undefined) attributes[target] = trace.metadata[source];
    for (const field of ["input", "output"])
      if (span.attributes[field] !== undefined)
        attributes[`langfuse.observation.${field}`] = JSON.stringify(span.attributes[field]);
    if (span.attributes.modelId) attributes["langfuse.observation.model.name"] = span.attributes.modelId;
    if (span.kind === "llm")
      attributes["langfuse.observation.usage_details"] = JSON.stringify({
        input: span.attributes.promptTokens ?? 0,
        output: span.attributes.completionTokens ?? 0,
        total: span.attributes.tokens ?? 0,
      });
    return attributes;
  }
}
