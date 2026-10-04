import type { Agent, EventBus } from "@agentium/core";
import { ConsoleExporter } from "./exporters/console.js";
import { JsonFileExporter } from "./exporters/json-file.js";
import { LangfuseExporter } from "./exporters/langfuse.js";
import { LangfuseOTLPExporter } from "./exporters/langfuse-otlp.js";
import { OTelExporter } from "./exporters/otel.js";
import { MetricsCollector } from "./metrics.js";
import { StructuredLogger } from "./structured-logger.js";
import { Tracer } from "./tracer.js";
import type { ExporterShorthand, ObservabilityConfig, TraceExporter } from "./types.js";

export interface InstrumentResult {
  tracer: Tracer;
  metrics: MetricsCollector | null;
  logger: StructuredLogger | null;
  detach: () => void;
  shutdown: () => Promise<void>;
}

function resolveExporters(raw: ObservabilityConfig["exporters"], config?: ObservabilityConfig): TraceExporter[] {
  if (!raw || raw.length === 0) return [];

  return raw.map((e) => {
    if (typeof e !== "string") return e;

    const shorthand: Record<ExporterShorthand, () => TraceExporter> = {
      console: () => new ConsoleExporter(config),
      langfuse: () => new LangfuseExporter(config),
      "langfuse-otlp": () => new LangfuseOTLPExporter(config),
      "json-file": () => new JsonFileExporter(config),
      otel: () => new OTelExporter(config),
    };

    const factory = shorthand[e];
    if (!factory) throw new Error(`Unknown exporter: "${e}". Use "console", "langfuse", "json-file", or "otel".`);
    return factory();
  });
}

function buildResult(eventBus: EventBus, config?: ObservabilityConfig): InstrumentResult {
  const exporters = resolveExporters(config?.exporters, config);

  const tracer = new Tracer(exporters, config);
  tracer.attach(eventBus);

  let metrics: MetricsCollector | null = null;
  if (config?.metrics !== false) {
    metrics = new MetricsCollector();
    metrics.attach(eventBus);
  }

  let logger: StructuredLogger | null = null;
  if (config?.structuredLogs) {
    const drain = config.structuredLogs === true ? "json" : config.structuredLogs;
    logger = new StructuredLogger(drain, tracer, config);
    logger.attach(eventBus);
  }

  const detach = () => {
    tracer.detach(eventBus);
    metrics?.detach(eventBus);
    logger?.detach(eventBus);
  };

  return {
    tracer,
    metrics,
    logger,
    detach,
    shutdown: async () => {
      detach();
      metrics?.shutdown();
      await Promise.all([tracer.shutdown(), logger?.shutdown()]);
    },
  };
}

/**
 * Attach observability to an agent in one call.
 *
 * ```ts
 * import { instrument } from "@agentium/observability";
 *
 * // Minimal — just pass string shorthands:
 * const obs = instrument(agent, { exporters: ["langfuse", "console"] });
 *
 * // Or bring your own exporter instances for custom config:
 * const obs = instrument(agent, {
 *   exporters: [new LangfuseExporter({ baseUrl: "..." }), "console"],
 * });
 * ```
 */
export function instrument(agent: Agent, config?: ObservabilityConfig): InstrumentResult {
  return buildResult(agent.eventBus, config);
}

/**
 * Attach observability to a raw EventBus (for teams, workflows, or custom setups).
 */
export function instrumentBus(eventBus: EventBus, config?: ObservabilityConfig): InstrumentResult {
  return buildResult(eventBus, config);
}
