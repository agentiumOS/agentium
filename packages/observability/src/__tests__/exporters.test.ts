import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { postTelemetry } from "../exporters/http.js";
import { JsonFileExporter } from "../exporters/json-file.js";
import { LangfuseExporter } from "../exporters/langfuse.js";
import { LangfuseOTLPExporter } from "../exporters/langfuse-otlp.js";
import { nanoseconds, OTelExporter } from "../exporters/otel.js";
import { fixtureTrace } from "./telemetry-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

import { localReceiver } from "./http-fixture.js";

it("rejects unsupported protocol and ambiguous endpoint configuration synchronously", () => {
  expect(() => new OTelExporter({ endpoint: "http://localhost", protocol: "http/protobuf" })).toThrow(
    /http\/json only/,
  );
  expect(
    () => new OTelExporter({ endpoint: "http://localhost", tracesEndpoint: "http://localhost/v1/traces" }),
  ).toThrow(/Choose/);
  expect(() => new OTelExporter({ endpoint: "http://user:secret@localhost" })).toThrow(/without credentials/);
});
it("uses exact nanosecond strings, hex IDs, flags, parent context, scalar/array/object attributes", () => {
  const trace = fixtureTrace();
  trace.spans[0].parentSpanId = "c".repeat(16);
  trace.spans[0].traceFlags = 0;
  trace.spans[0].traceState = "vendor=value";
  trace.spans[0].attributes = {
    modelId: "test",
    providerId: "synthetic",
    promptTokens: 7,
    completionTokens: 2,
    enabled: true,
    nested: { x: 1 },
    list: [1, 2],
  };
  trace.spans[0].kind = "llm";
  const payload = new OTelExporter({ endpoint: "http://localhost", capture: { mode: "content" } }).payload(trace);
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  expect(span).toMatchObject({
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: "c".repeat(16),
    flags: 0,
    traceState: "vendor=value",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000001000000",
  });
  const attrs = Object.fromEntries(span.attributes.map((entry) => [entry.key, entry.value]));
  expect(attrs["gen_ai.provider.name"]).toEqual({ stringValue: "synthetic" });
  expect(attrs.list).toEqual({ arrayValue: { values: [{ intValue: "1" }, { intValue: "2" }] } });
  expect(attrs.nested).toEqual({ stringValue: '{"x":1}' });
  expect(nanoseconds(1234.5)).toBe("1234500000");
});
it("local HTTP receiver sees correct base/full endpoint paths and partial success is never retried", async () => {
  const received: { path?: string; body: string; contentType?: string }[] = [];
  const server = await localReceiver((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ path: request.url, body, contentType: request.headers["content-type"] });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "PRIVATE_SERVER_ERROR" } }));
    });
  });
  try {
    const exporter = new OTelExporter({ endpoint: server.base });
    await exporter.export(fixtureTrace());
    await new OTelExporter({ tracesEndpoint: `${server.base}/custom` }).export(fixtureTrace());
    expect(received.map((r) => r.path)).toEqual(["/v1/traces", "/custom"]);
    expect(received.every((r) => r.contentType === "application/json")).toBe(true);
    expect(received[0].body).not.toMatch(/PRIVATE_|SECRET/);
    expect(exporter.getDiagnostics()).toMatchObject({ otlp_partial_success: 1 });
  } finally {
    await server.close();
  }
});
it("retries bounded HTTP status failures and never retries rejection/partial success", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await postTelemetry("http://localhost", "{}", {}, { maxRetries: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockReset().mockResolvedValue(new Response("PRIVATE_SERVER_ERROR", { status: 400 }));
  await expect(postTelemetry("http://localhost", "{}", {}, { maxRetries: 5 })).rejects.toThrow("HTTP status 400");
  expect(fetchMock).toHaveBeenCalledOnce();
});
it("aborts hanging fetch at deadline and clears request timers on every exit", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(
    (_url, options) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = postTelemetry("http://localhost", "{}", {}, { timeoutMs: 10, maxRetries: 0 });
  const failure = expect(result).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(11);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
  fetchMock.mockImplementation(async () => new Response("{}"));
  await postTelemetry("http://localhost", "{}", {}, { timeoutMs: 10 });
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds request and response bytes without echoing server bodies", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ private: "x".repeat(1000) })));
  vi.stubGlobal("fetch", fetchMock);
  await expect(postTelemetry("http://localhost", "{}", {}, { maxResponseBytes: 20 })).rejects.toThrow(
    "response exceeds",
  );
  await expect(postTelemetry("http://localhost", "long", {}, { maxRequestBytes: 2 })).rejects.toThrow(
    "payload exceeds",
  );
  expect(fetchMock).toHaveBeenCalledOnce();
});
it("append exporter produces independently parseable JSONL with capture enforced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentium-jsonl-"));
  const path = join(directory, "traces.jsonl");
  try {
    const exporter = new JsonFileExporter({ path });
    await exporter.export(fixtureTrace());
    await exporter.export(fixtureTrace());
    const text = await readFile(path, "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).traceId)).toEqual(["a".repeat(32), "a".repeat(32)]);
    expect(text).not.toMatch(/PRIVATE_|SECRET/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("Langfuse OTLP uses v4 endpoint/header and copies sanitized trace context onto finished observations", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const trace = fixtureTrace();
  trace.spans.push({
    ...trace.spans[0],
    spanId: "c".repeat(16),
    parentSpanId: trace.rootSpanId,
    kind: "llm",
    attributes: { modelId: "test", promptTokens: 2, completionTokens: 1, tokens: 3 },
  });
  await new LangfuseOTLPExporter({
    publicKey: "fixture-public",
    secretKey: "fixture-secret",
    baseUrl: "http://localhost",
  }).export(trace);
  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toBe("http://localhost/api/public/otel/v1/traces");
  expect(request.headers["x-langfuse-ingestion-version"]).toBe("4");
  expect(request.headers.Authorization).toMatch(/^Basic /);
  const spans = JSON.parse(request.body).resourceSpans[0].scopeSpans[0].spans;
  for (const span of spans) {
    const attrs = Object.fromEntries(span.attributes.map((entry: any) => [entry.key, entry.value.stringValue]));
    expect(attrs["langfuse.trace.name"]).toBe("demo");
    expect(attrs["langfuse.session.id"]).toBe("s");
    expect(attrs["langfuse.observation.input"]).toBeUndefined();
  }
  expect(request.body).not.toContain("fixture-secret");
});
it("legacy Langfuse remains explicit and diagnoses 207 item rejection without sensitive response content", async () => {
  const diagnostics: unknown[] = [];
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "PRIVATE_SERVER_ERROR" }] }), { status: 207 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const exporter = new LangfuseExporter({
    publicKey: "fixture-public",
    secretKey: "fixture-secret",
    baseUrl: "http://localhost",
    onDiagnostic: (d) => {
      diagnostics.push(d);
    },
  });
  await expect(exporter.export(fixtureTrace())).rejects.toThrow(/rejected/);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_");
  expect(diagnostics).toContainEqual({ code: "legacy_langfuse_ingestion_deprecated" });
});
