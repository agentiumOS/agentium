import type { Span, Trace, TraceExporter } from "../types.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
};

function c(code: string, text: string): string {
  return `${code}${text}${C.reset}`;
}

function statusIcon(status: string): string {
  if (status === "ok") return c(C.green, "✓");
  if (status === "error") return c(C.red, "✗");
  return c(C.yellow, "⋯");
}

function kindColor(kind: string): string {
  switch (kind) {
    case "agent":
      return C.brightCyan;
    case "llm":
      return C.yellow;
    case "tool":
      return C.magenta;
    case "handoff":
      return C.brightGreen;
    case "team":
      return C.cyan;
    default:
      return C.gray;
  }
}

export class ConsoleExporter implements TraceExporter {
  name = "console";

  async export(trace: Trace): Promise<void> {
    const line = c(C.dim, "─".repeat(80));
    console.log(`\n${line}`);
    console.log(
      `  ${c(C.bold + C.brightCyan, "Trace")} ${c(C.dim, trace.traceId)} ` +
        `${c(C.dim, "duration=")}${c(C.brightGreen, `${trace.durationMs ?? "?"}ms`)}`,
    );

    if (trace.metadata.agentName) {
      console.log(`  ${c(C.dim, "agent=")}${trace.metadata.agentName}`);
    }

    console.log(line);

    const spanMap = new Map<string, Span[]>();
    for (const span of trace.spans) {
      const parentId = span.parentSpanId ?? "__root__";
      if (!spanMap.has(parentId)) spanMap.set(parentId, []);
      spanMap.get(parentId)!.push(span);
    }

    const root = trace.spans.find((s) => s.spanId === trace.rootSpanId);
    if (root) {
      this.printSpan(root, spanMap, 0, trace.startTime);
    }

    console.log(line);
    console.log("");
  }

  private printSpan(span: Span, childMap: Map<string, Span[]>, depth: number, traceStart: number): void {
    const indent = `  ${"│ ".repeat(depth)}`;
    const connector = depth > 0 ? "├─ " : "";
    const offset = span.startTime - traceStart;
    const dur = span.durationMs ?? "?";

    const kc = kindColor(span.kind);
    const icon = statusIcon(span.status);

    let line = `${indent}${connector}${icon} ${c(kc, span.name)}`;
    line += ` ${c(C.dim, `[${offset}ms → +${dur}ms]`)}`;

    if (span.attributes.tokens) {
      line += ` ${c(C.brightGreen, `${span.attributes.tokens} tok`)}`;
    }
    if (span.attributes.toolName) {
      line += ` ${c(C.dim, `(${span.attributes.toolName})`)}`;
    }
    if (span.attributes.cached) {
      line += ` ${c(C.yellow, "[cached]")}`;
    }
    if (span.status === "error" && span.attributes.error) {
      line += ` ${c(C.red, String(span.attributes.error))}`;
    }

    console.log(line);

    for (const evt of span.events) {
      console.log(
        `${indent}│ ${c(C.dim, `⤷ ${evt.name}`)}${evt.attributes ? c(C.gray, ` ${JSON.stringify(evt.attributes)}`) : ""}`,
      );
    }

    const children = childMap.get(span.spanId) ?? [];
    for (const child of children) {
      this.printSpan(child, childMap, depth + 1, traceStart);
    }
  }
}
