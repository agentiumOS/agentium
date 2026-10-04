import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { OTelExporter } from "../exporters/otel.js";
import { OTelBridgeExporter } from "../exporters/otel-bridge.js";
import { localReceiver } from "./http-fixture.js";
import { fixtureTrace } from "./telemetry-fixture.js";

const exec = promisify(execFile);
const fixture = process.env.AGENTIUM_OTEL_SDK_FIXTURE;
const python = process.env.AGENTIUM_OTEL_PROTO_PYTHON;
it.skipIf(!fixture)("real host SDK compiles structurally, exports parented spans and remains host-owned", async () => {
  const require = createRequire(join(fixture!, "package.json"));
  const api = require("@opentelemetry/api");
  const sdk = require("@opentelemetry/sdk-trace-base");
  const transformer = require("@opentelemetry/otlp-transformer");
  const exporter = new sdk.InMemorySpanExporter();
  const provider = new sdk.BasicTracerProvider({ spanProcessors: [new sdk.SimpleSpanProcessor(exporter)] });
  const shutdown = vi.spyOn(provider, "shutdown");
  const globalBefore = api.trace.getTracerProvider();
  const bridge = new OTelBridgeExporter({
    provider,
    contextFor(parent) {
      return parent
        ? api.trace.setSpanContext(api.ROOT_CONTEXT, {
            ...parent,
            traceFlags: parent.traceFlags ?? 1,
            traceState: parent.traceState ? api.createTraceState(parent.traceState) : undefined,
          })
        : api.ROOT_CONTEXT;
    },
  });
  const trace = fixtureTrace();
  trace.spans[0].parentSpanId = "d".repeat(16);
  trace.spans[0].traceFlags = 1;
  trace.spans[0].traceState = "vendor=value";
  trace.spans.push({
    ...trace.spans[0],
    spanId: "c".repeat(16),
    parentSpanId: trace.rootSpanId,
    kind: "llm",
    name: "llm.test",
    attributes: { modelId: "test", providerId: "synthetic", promptTokens: 2, completionTokens: 1 },
  });
  const directory = await mkdtemp(join(fixture!, "consumer-"));
  try {
    await bridge.export(trace);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans[0].spanContext().traceId).toBe(trace.traceId);
    expect(spans[0].parentSpanContext.spanId).toBe("d".repeat(16));
    expect(spans[1].parentSpanContext.spanId).toBe(spans[0].spanContext().spanId);
    expect(spans[0].spanContext().traceState.serialize()).toBe("vendor=value");
    expect(api.trace.getTracerProvider()).toBe(globalBefore);
    expect(shutdown).not.toHaveBeenCalled();
    const wire = JSON.parse(Buffer.from(transformer.JsonTraceSerializer.serializeRequest(spans)).toString());
    expect(wire.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(JSON.stringify(wire)).not.toMatch(/PRIVATE_|SECRET/);
    const bridgePath = fileURLToPath(new URL("../exporters/otel-bridge.js", import.meta.url));
    await writeFile(
      join(directory, "consumer.mts"),
      `import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';\nimport { ROOT_CONTEXT, trace, createTraceState } from '@opentelemetry/api';\nimport { OTelBridgeExporter } from ${JSON.stringify(bridgePath)};\nconst provider = new BasicTracerProvider();\nnew OTelBridgeExporter({provider,contextFor(parent){return parent?trace.setSpanContext(ROOT_CONTEXT,{...parent,traceFlags:parent.traceFlags??1,traceState:parent.traceState?createTraceState(parent.traceState):undefined}):ROOT_CONTEXT;}});`,
    );
    await exec(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        join(directory, "consumer.mts"),
      ],
      { timeout: 10000, maxBuffer: 64000 },
    );
  } finally {
    await provider.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
it.skipIf(!python)(
  "local OTLP receiver decodes with official protobuf definitions and validates timestamps/IDs",
  async () => {
    const decoded: any[] = [];
    let failure: unknown;
    const script = `import json,base64,sys\nfrom google.protobuf.json_format import ParseDict\nfrom opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest\ndata=json.loads(sys.argv[1])\nfor resource in data['resourceSpans']:\n for scope in resource['scopeSpans']:\n  for span in scope['spans']:\n   for key in ['traceId','spanId','parentSpanId']:\n    if key in span: span[key]=base64.b64encode(bytes.fromhex(span[key])).decode()\nrequest=ParseDict(data,ExportTraceServiceRequest())\nspan=request.resource_spans[0].scope_spans[0].spans[0]\nassert len(span.trace_id)==16 and len(span.span_id)==8\nprint(json.dumps({'traceId':span.trace_id.hex(),'spanId':span.span_id.hex(),'start':str(span.start_time_unix_nano),'end':str(span.end_time_unix_nano),'name':span.name}))`;
    const server = await localReceiver((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        void exec(python!, ["-c", script, body], { timeout: 5000, maxBuffer: 64000 }).then(
          ({ stdout }) => {
            decoded.push(JSON.parse(stdout));
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          },
          (error) => {
            failure = error;
            response.writeHead(400);
            response.end("{}");
          },
        );
      });
    });
    try {
      await new OTelExporter({ endpoint: server.base, maxRetries: 0 }).export(fixtureTrace());
      expect(failure).toBeUndefined();
      expect(decoded).toEqual([
        {
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          start: "1700000000000000000",
          end: "1700000000001000000",
          name: "agent.run",
        },
      ]);
    } finally {
      await server.close();
    }
  },
);
