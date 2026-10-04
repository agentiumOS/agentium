# MCP adapter compatibility

`MCPToolProvider` retains the SDK v1 adapter for existing stdio, Streamable HTTP and SSE servers. Install `@modelcontextprotocol/sdk@^1.27.1`. Its tool results now preserve complete MCP content/metadata as an `mcp-result` artifact, and tool-level errors throw `MCPToolError` with the original mapped result. Callers that previously assumed every result was a string should read `ToolResult.content`.

`MCPV2ToolProvider` uses the split `@modelcontextprotocol/client@^2.3.0` SDK. It defaults to protocol **2026-07-28**, pinned without silent fallback. Set `versionNegotiation: { mode: "auto" }` explicitly to allow the SDK's legacy negotiation. The modern transport options are `http`, `stdio`, and a host-supplied `custom` transport factory; v1 SSE remains on the legacy adapter.

```ts
import { MCPV2ToolProvider } from "@agentium/core";
const mcp = new MCPV2ToolProvider({
  name: "reports", transport: "http", url: "https://mcp.example.com/mcp",
  audience: "https://mcp.example.com/mcp",
  headers: { Authorization: `Bearer ${token}` },
  onToolsChanged: (tools, error) => { /* rebuild host tool selection on successful updates */ },
});
const tools = await mcp.getTools({ include: ["find_reports"] });
// Bind the selected tools to an Agent/harness and apply ordinary execution policy.
await mcp.close();
```

Initialization is shared until tool discovery completes. Closing during initialization invalidates that attempt and closes late-arriving transports; failed discovery can be retried. Both adapters capture their endpoint/header configuration at construction. Legacy SSE uses the SDK transport, including its endpoint-origin checks.

Connections carry host-supplied credentials. Use a distinct provider instance per authenticated principal; user/tenant fields in a run do not change an OAuth token. Credentialed HTTP connections require an exact configured audience URL; redirects and cross-origin fetches are refused. This protects forwarding, not token issuance: obtain and validate tokens through your authorization server. `authProvider` accepts the SDK provider interface, but cross-origin authorization-server discovery is intentionally blocked by this strict transport; pre-obtain tokens or supply a host-reviewed custom transport for multi-origin OAuth. No automatic consent, sampling callback or root filesystem access is installed.

Ordinary input-required responses surface the SDK's typed error containing the opaque continuation. A host may explicitly opt into `inputRequired: {autoFulfill:true}` and install trusted elicitation handlers through `configureClient`. The adapter passes each tool's run cancellation signal into SDK requests. Tool-list changes update future `getTools()` results; an Agent's already-bound tool array is a snapshot and must be rebuilt explicitly.

## Optional current Tasks extension

Set `tasks: true` only when the server advertises `io.modelcontextprotocol/tasks` on a modern connection. The adapter refuses a connection that does not negotiate it. It sends the capability on every task-related request and uses a transport coordinator with independent string request IDs because the base SDK intentionally rejects `resultType: "task"`.

A task-backed tool call returns a JSON `content` containing a local opaque `handle`, neutral status and polling hint. Host code retains the owning `RunContext` and uses:

- `getTask(handle, ctx)` to poll, respecting the returned `pollAfterMs`.
- `respondToTask(handle, responses, ctx)` to answer outstanding input requests after host review; unknown and already answered keys are denied.
- `cancelTask(handle, ctx)` to request remote cancellation. The acknowledgement sets `cancellationRequested`; it never falsely reports completed cancellation.
- `releaseTask(handle, ctx)` to discard local state after consuming results.

Handles bind to run, session, user and tenant. Cross-owner lookup sends no remote request. TTLs and a configurable maximum of 1,000 retained handles bound local state. Completed/failed/cancelled snapshots are terminal locally. Results retain structured content and resources, and input-required state remains visible. Task handles are **connection-local**, not a durable task database: `close()` drops local state and disconnects; it does not cancel remote tasks or recover them after a process restart. Use an application task store and a host adapter for cross-process recovery. No task wire objects enter the harness kernel.

The built-in HTTP transport sets task routing headers from the same request body. A custom transport must implement the current extension's routing/framing requirements. The interoperability fixture uses the actual v2 server HTTP handler for discovery and ordinary tools, and normative Tasks wire responses for input/cancel controls. This is a bounded adapter, not a claim that every remote MCP service or every optional extension has been certified.

Official references: [SDK v2 migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md), [current MCP specification](https://modelcontextprotocol.io/specification/2026-07-28), [Tasks wire specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks).
