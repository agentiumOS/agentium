# Agent handoff

Configure `handoff.targets` with specialist Agents, then call `agent.run()` or `agent.stream()`. The model requests `transfer_to_agent`; schema validation, source policy and approval run before the transfer is authorized. All sibling tools settle and their results close the complete assistant/tool batch before the target starts. A denied/failed sibling or multiple simultaneous transfers blocks delegation.

```ts
const triage = new Agent({
  name: "triage",
  model,
  handoff: {
    maxHandoffs: 3,
    targets: [{ agent: specialist, description: "Handles specialist requests" }],
  },
});
for await (const chunk of triage.stream("Help with my request", {
  sessionId: "conversation",
  userId: "actor",
  tenantId: "tenant",
  signal: controller.signal,
})) {
  if (chunk.type === "text") render(chunk.text);
}
```

Streaming preserves live target chunks and backpressure. `StreamChunk` is unchanged; `finish` chunks describe individual model calls, so consume the iterator to completion rather than stopping at the first finish. Existing `handoff.transfer` and `handoff.complete` EventBus events identify delegation boundaries. The source `run.complete` output contains aggregate visible text, usage, tool calls, `handoffChain`, `finalAgent` and canonical `newMessages`. Each Agent's cost tracker charges only that Agent's model usage.

Streaming targets receive explicit conversation history under an ephemeral delegated session. They neither load an unrelated existing target session nor persist a second copy of the source conversation. The latest user turn is not duplicated. Source instructions remain source-owned; the target builds its own instructions. Canonical user/assistant/tool messages and matched call IDs cross the boundary. Opaque provider replay envelopes cross only when both Agents share the exact model-provider instance and the source has no per-run API-key override. Other boundaries omit those private envelopes; the source retains its own original envelopes. Provider-specific cross-model reasoning replay remains subject to provider support.

The source and target policy/approval gates both apply. Delegation carries user/tenant identity, mode, signal, root/parent run linkage and, by default, a cloned session state. A missing source user identity does not become the target's configured default user. Target credentials are target-owned: a source per-run API-key override is not forwarded by streaming handoff. `carryMessages: false` and `carrySessionState: false` disable their respective carry behavior. The target's resulting state does not overwrite the source's state.

Depth limits are inherited across independently configured Agents; each hop consumes one slot. Reentering an agent name in the chain rejects before the target starts. `onHandoff` is an intentional control hook, and cancellation is rechecked after it. Tool-result text, metadata, or a hook throwing `HandoffSignal` cannot create streaming transfer authority: the framework tracks authorized control in process-local state.

Abort and iterator return close active target iterators. In-flight tools settle before their completed batch is retained. Failed/cancelled chains preserve closed source/target tool groups in the source session without orphaned tool calls; unfinished or rejected final answers are omitted. Output guardrails and `afterRun` run before terminal success. Because content is streamed live, a guardrail may reject after partial text has already been delivered; consumers should treat an error as an incomplete answer. No success lifecycle is emitted on early iterator return.

Ordinary `run()` retains its existing summary-based delegation behavior and target session ownership. Streaming handoff is supported for ordinary Agents; it remains explicitly rejected when `executionServices` is supplied. A controlled harness must provide host-owned delegation so target tools, aggregate budgets, canonical history and one-writer session ownership stay within the runtime's grants. The new streaming path does not bypass that guard or add a core dependency on `@agentium/harness`.

Tests use synthetic providers and counters to verify live delivery, history replay, costs, source/target policies, inherited approval cleanup, cancellation, consumer return, output guards, state/history opt-outs, cycles and inherited hop limits. No paid provider calls are part of these tests.
