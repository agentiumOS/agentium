# @agentium/observability

Opt-in tracing, metrics and structured logging. The default capture policy keeps bounded lifecycle metadata and usage; prompts, tool arguments/results, output text and error bodies are excluded before retention or delivery.

```ts
import { instrument, OTelExporter } from "@agentium/observability";

const observation = instrument(agent, {
  exporters: [new OTelExporter({ endpoint: "http://127.0.0.1:4318" })],
  metrics: true,
  onDiagnostic: ({ code }) => telemetryHealth.increment(code),
});
await agent.run("Hello");
await observation.shutdown();
```

`instrumentBus(eventBus, options)` supports shared buses. `detach()` removes this observer's subscriptions; `shutdown()` also drains owned work within the configured deadline. Attachments are idempotent per bus, and detaching one bus preserves other attachments. A shut-down observer cannot be attached again.

## Observation and capture

Core `EventBus` subscriptions are observation-only: named and `onAny` listeners run without awaiting promises, in their existing order. A thrown exception or rejected promise does not skip later observers or alter an Agent/tool result. `once`, `off` and listener identity remain supported. Control hooks, execution policy and approval remain explicit control APIs and retain their intentional failure behavior.

`new EventBus({ onObserverError, maxObserverDiagnostics: 100 })` reports bounded, nonrecursive observer failures. The diagnostic callback is host-owned, may see the original error, and is never logged implicitly. `getObserverDiagnostics()` reports total, reported and suppressed failures. Telemetry's separate `onDiagnostic` receives payload-free codes; diagnostic callback failures are isolated too.

**Migration:** previous automatic content capture is removed. Selecting an exporter is not content permission. To retain content, opt in at both the tracer and each explicitly constructed destination:

```ts
const capture = {
  mode: "content" as const,
  redact(path: string, value: unknown) {
    if (path === "userId" || path.endsWith(".email")) return undefined;
    return value;
  },
  maxAttributeBytes: 2048,
  maxTotalBytes: 16384,
};
const observation = instrument(agent, {
  capture,
  exporters: [new JsonFileExporter({ path: "traces.jsonl", capture })],
});
```

Shorthand exporters inherit the instrument capture options. Direct callback, console, file, OTel and Langfuse exporters independently apply capture, so an unsafe externally supplied trace is not implicitly trusted. Content mode preserves the former payload capability within explicit bounds; it never includes error stacks. Known credential-key fields are always removed, including nested fields. Text may itself contain sensitive data, so supply an application redactor when capturing content. Redactors are synchronous; accidental promises are dropped with rejection handling. Cycles, binary values, deep objects and oversized values are handled without arbitrary `toJSON` calls.

Metadata includes agent/tool/model names, run/session/user/tenant and parent/root/attempt IDs, usage, cost and outcome. These identifiers can also be personal data: redact them as needed. Arbitrary custom attributes are excluded in metadata mode. Model lifecycle events contain identity and usage rather than full request/response bodies; content opt-in does not fabricate data unavailable from the producer.

## Bounds and lifecycle

| Bound | Default | Configuration |
| --- | --- | --- |
| Export queue, including in-flight work | 128 records, 4 MiB, 2 concurrent | `maxQueuedExports`, `maxQueuedBytes`, `maxInFlight` |
| Flush/shutdown wait | 5 seconds | `flushTimeoutMs` |
| Trace retention | 1,000 traces, 8 MiB, 1 hour | `TracerOptions.maxTraces`, `maxRetainedBytes`, `retentionMs` |
| Per trace / span | 256 spans / 64 events | `maxSpansPerTrace`, `maxEventsPerSpan` |
| Attribute capture | 64 fields, 2 KiB each, 16 KiB combined | `capture.maxAttributes`, `maxAttributeBytes`, `maxTotalBytes` |
| Direct-export trace capture | 1 MiB, up to 256 spans and 64 events per span | `capture.maxTraceBytes` plus fixed structural caps |
| Metrics retention | 1,000 records/active runs, 10,000 active tools/histogram entries, 256 agent labels | `AccountingOptions` |
| Dashboard streams | 32 subscribers, 128 records / 256 KiB per subscriber | `MetricsExporterOptions` |
| Diagnostic callback deliveries | 100 per component lifetime | `maxDiagnostics` |

The export queue drops newest records when full. Trace retention evicts oldest entries; over-limit spans/events are dropped. Subscriber buffers drop oldest events. `getDiagnostics()` exposes queue state/drop counts on tracer, logger and dashboard; exporters expose diagnostics through the optional callback. Age retention is checked on observation/read rather than a background timer.

Slow exporters never block Agent completion. Timed-out noncooperative callbacks retain their in-flight slots and owned resources; replacement work cannot grow unbounded. Shutdown aborts cooperative requests and drops remaining queued records. Resource shutdown is deferred until already-started export/flush work actually settles, invoked once, and cannot force a permanently stalled callback to cooperate. `flush()` is a bounded best-effort wait, not a delivery guarantee. Host-managed OTel providers remain host-owned.

## Correlation and metrics

Core run/stream model invocations emit `model.start`, `model.result` or `model.error` with unique `modelCallId`; retries have separate invocation spans. Tool producers include `toolCallId`, `status` and `cached` where known. Concurrent calls to the same tool are matched by ID. Legacy events lacking IDs are matched only when one candidate is unambiguous. Denied tools can produce a result without a call event because authorization precedes execution; such a denial does not invent an executed-tool span.

Both metrics APIs use the same accounting implementation. A terminal outcome is counted once; cancelled, stopped and awaiting-input outputs are not counted successful. Terminal runs clear active tool entries, and tracers mark unfinished child spans interrupted. Costs are cumulative per-run records keyed by `runId`, including events before completion. Late cost updates change retained metrics; already-exported finished spans are not re-ingested. Token totals use terminal run usage; provider-internal retries or failed calls without reported usage cannot be inferred. Direct custom H2 controller/model calls outside an Agent loop need a host event adapter; core has no dependency on the harness runtime.

`MetricsCollector` counters/totals are cumulative since reset; histogram arrays are bounded samples. `MetricsExporter.getMetrics()` and JSON summarize retained completed runs; corrections/critique aggregates are cumulative. Prometheus `_total` series are cumulative, while duration/rate gauges describe retained runs. Labels are escaped and excess agent-label cardinality is grouped into `__other__`. Metrics are process-local telemetry, not durable billing records.

## OTLP and host SDK integration

`OTelExporter` implements **OTLP/HTTP JSON**. `protocol: "http/protobuf"` or an unsupported protocol environment setting rejects at construction. Use the host SDK bridge and its chosen exporter for protobuf. `endpoint` is a base URL and appends `/v1/traces`; `tracesEndpoint` is a complete signal URL. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` precedes the generic endpoint when neither is configured. Headers and service name accept the corresponding standard environment settings or explicit options. Endpoints reject embedded credentials, query strings and fragments; pass credentials through headers.

Trace/span IDs are valid hex, timestamps use integer nanosecond strings, and host-supplied upstream context is preserved through `new Tracer(exporters, { parentContext })`. `parentContext` may be a verified context or a host callback reading run metadata. Arbitrary input is not parsed as tracing authority. The selected mapping uses [semantic conventions 1.37.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-spans.md), including model/provider/usage and tool-call attributes; GenAI conventions remain developmental and now evolve in a separate repository. Model spans are client spans; tool spans are internal.

HTTP 200 partial acceptance reports `otlp_partial_success` and its rejected count without retrying accepted spans. Only connection failures and HTTP 429/502/503/504 are retried, with bounded backoff/`Retry-After`, a shared request deadline, and request/response byte limits. Defaults: 10 seconds, 2 retries, 4 MiB request, 64 KiB response. Timers are cleared on every exit. This follows the [OTLP specification](https://opentelemetry.io/docs/specs/otlp/); retries after an ambiguous connection loss are not exactly-once delivery.

```ts
import { ROOT_CONTEXT, trace, createTraceState } from "@opentelemetry/api";
import { OTelBridgeExporter } from "@agentium/observability";

const bridge = new OTelBridgeExporter({
  provider: myExistingProvider, // alternatively tracer: myExistingTracer
  contextFor(parent) {
    return parent ? trace.setSpanContext(ROOT_CONTEXT, {
      ...parent,
      traceFlags: parent.traceFlags ?? 1,
      traceState: parent.traceState ? createTraceState(parent.traceState) : undefined,
    }) : ROOT_CONTEXT;
  },
});
```

The bridge uses the supplied SDK, never registers a global provider, and never flushes/shuts down the host provider. The host chooses sampling, processors, binary exporters and shutdown. Exported finished spans use their original times; SDK-generated local IDs are linked by `agentium.source.span_id`. Upstream trace IDs and child relationships survive the bridge. Without an upstream parent, the SDK owns the new trace ID. No OTel SDK is a mandatory Agentium dependency.

## Langfuse and files

| Exporter / shorthand | Use |
| --- | --- |
| `LangfuseOTLPExporter` / `"langfuse-otlp"` | Current OTLP endpoint, Basic project credentials, `x-langfuse-ingestion-version: 4` |
| `LangfuseExporter` / `"langfuse"` | Explicit legacy `/api/public/ingestion` compatibility; diagnostic emitted at construction |
| `OTelExporter` / `"otel"` | OTLP/HTTP JSON collector |
| `JsonFileExporter` / `"json-file"` | Append defaults to compact JSONL; overwrite defaults to pretty JSON |
| `ConsoleExporter` / `"console"` | Bounded trace tree |
| `CallbackExporter` | Host-selected sanitized callback |

Langfuse uses `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and optional `LANGFUSE_BASE_URL`, or explicit constructor fields. The OTLP mapping exports finished observations, copies sanitized trace/session/user metadata to every span, and maps model usage. No model/provider text is invented. [Langfuse's compatibility documentation](https://langfuse.com/docs/compatibility) schedules legacy Cloud trace/observation ingestion removal for **November 16, 2026**; self-hosted v4 `events_only` already rejects it. Use its [v4 migration guidance](https://langfuse.com/integrations/native/opentelemetry/migration-to-v4). Do not dual-send the same spans through old and new ingestion paths in one project; use separate canary destinations. Live-account ingestion and self-hosted-version compatibility remain deployment checks.

JSONL append writes one independently parseable object per line. Explicit `pretty: true` with append preserves multiline legacy behavior and is not JSONL. `mode: "overwrite"` writes a single JSON document. Write failures reject direct calls and emit payload-free diagnostics; instrumented exporters isolate those failures from execution.

## Verification fixtures

Ordinary tests cover public Agent effects, observer failures, capture/redaction, concurrent call IDs, retention/subscriber/export bounds, terminal outcomes, retry/partial success, local HTTP delivery and JSONL. Optional real SDK/official decoder gates require isolated fixture dependencies; no account or model call is involved:

```bash
npm install --prefix /tmp/agentium-otel-fixture --ignore-scripts --no-audit --no-fund \
  @opentelemetry/api@1.9.1 @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/otlp-transformer@0.222.0
python3 -m venv /tmp/agentium-otel-proto-fixture
/tmp/agentium-otel-proto-fixture/bin/pip install opentelemetry-proto==1.38.0 protobuf==6.33.6
AGENTIUM_OTEL_SDK_FIXTURE=/tmp/agentium-otel-fixture \
AGENTIUM_OTEL_PROTO_PYTHON=/tmp/agentium-otel-proto-fixture/bin/python \
  npx vitest run packages/observability/src/__tests__/otel-sdk.integration.test.ts
```

The SDK gate checks a real provider/exporter, static TypeScript compatibility, parent context and absence of global mutation. The loopback receiver decodes emitted requests with official protobuf definitions after the OTLP-mandated hex-to-bytes conversion. This verifies the wire contract, not a hosted collector's retention, sampling or vendor UI behavior.

### Harness controllers and custom model calls

Pass a dedicated `EventBus` as `HarnessRuntime({ telemetry })`, then call `instrumentBus(telemetry)`. Custom execution-service model calls and controller decisions produce correlated spans even without an Agent loop. Controllers use `internal` spans with invocation IDs, operation, decision, model role and active tool count; they do not increment model/tool counts. Runtime telemetry omits prompts and response content.

Use a separate collector from any wrapped Agent instrumentation: Agent and harness layers can share a run ID and describe the same model invocation. See the [harness telemetry example](../harness/README.md#custom-driver-and-controller-telemetry). Existing exporter redaction, retention limits and bounded shutdown still apply.
