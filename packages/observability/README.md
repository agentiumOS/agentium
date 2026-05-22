# @agentium/observability

Opt-in tracing, metrics, and structured logging for Agentium agents.

## Install

```bash
npm install @agentium/observability
```

## Quick Start

```typescript
import { Agent, openai } from "@agentium/core";
import { instrument } from "@agentium/observability";

const agent = new Agent({ name: "assistant", model: openai("gpt-4o") });

const obs = instrument(agent, {
  exporters: ["console"],       // or "langfuse", "otel", "json-file"
});

await agent.run("Hello!");
await obs.tracer.flush();
```

## Exporters

| Shorthand | Env Vars | Description |
|-----------|----------|-------------|
| `"console"` | — | Pretty-print trace tree |
| `"langfuse"` | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Langfuse cloud |
| `"otel"` | `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector |
| `"json-file"` | — | Local JSON file |

## Documentation

Full docs at [agentium.mintlify.dev](https://agentium.mintlify.dev)

## License

MIT
