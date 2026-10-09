# Conversational runs (4.6)

Questions, steering, public messages and compaction stay inside one live run.
The runtime retains the session lease, Agent instance, transcript, provider
continuations and remaining budgets. Waiting does not poll the model.

## Ask and resume

```ts
import { openai } from "@agentium/core";
import { agentDriver, HarnessRuntime, requestInputTool } from "@agentium/harness";

const runtime = new HarnessRuntime({
  driver: agentDriver({
    name: "analyst",
    model: openai("gpt-6-sol"),
    instructions: "Analyze the available data. Ask the user when a necessary detail is missing.",
  }, { stream: true }),
  tools: [requestInputTool()],
  grants: { toolIds: ["request_input"], modelRoles: ["main"] },
  budgets: { maxModelCalls: 20, maxToolCalls: 30, maxTokens: 100_000 },
  activeTimeoutMs: 120_000,
  inputTimeoutMs: 15 * 60_000,
});

const handle = runtime.start("Prepare a report", {
  identity: { tenantId: verifiedTenantId, userId: verifiedUserId },
  sessionId: conversationId,
});

// In the application's event consumer:
for await (const event of handle.events()) {
  if (event.payload.type === "input.requested") {
    showQuestion(event.payload.request); // Store its id with the form.
  } else {
    renderActivity(event);
  }
}

// In a separate form submission handler:
await handle.reply(requestIdFromForm, userAnswer);
const result = await handle.result(); // Resolves once, after the live wait.
```

The model chooses when to call the granted question tool. A custom tool or driver
can call `await services.requestInput({ question, choices?, timeoutMs? })`
directly. The returned `InputReply` contains `requestId` and `input`.
`choices` are presentation suggestions; the application may validate a richer
answer before submitting it. This API does not invent a form schema or force a
question on every run.

`handle.state` is `running`, `awaiting_input`, `cancelling`, or `finished`.
`handle.pendingInput` returns a cloned current question, useful when reconnecting
after an event-history gap. Only one question can be pending per run.

Replies claim the pending request synchronously. Duplicate, stale, wrong-run,
malformed and post-completion replies reject with `HarnessInputError.code`.
Messages are limited to 64KB; questions to 32KB. The application remains responsible
for authenticating the actor before exposing a handle or submitting a reply.
Events `input.requested`, `input.resolved`, and `run.resumed` share the request ID.

| Timeout | Includes waiting? | Expiry reason code |
| --- | --- | --- |
| start option `deadline` (absolute timestamp) | Yes | `deadline_exceeded` |
| runtime `activeTimeoutMs` | No | `active_timeout` |
| runtime `inputTimeoutMs`, overridden per question | Only the current wait | `input_timeout` |

Timeouts cancel the run cooperatively. `cancel()` also works during a question.
Cleanup waits for already-started work to settle; external effects are not rolled
back. Without an input timeout or deadline, a question can wait indefinitely.
No new model calls may start while a question is pending; concurrent work already
started before the question still has its usual cancellation/lifetime contract.

For minor-version compatibility, a custom driver that **returns** legacy
`status: "awaiting_input"`, or a completion policy returning `await_input`,
still produces the old terminal hand-back. That path cannot resume its stack.
Migrate live conversations to **awaiting `requestInput()`** inside the driver/tool;
the new `awaiting_input` handle state is nonterminal.

## Steer an active Agent

```ts
await handle.send("Only include last month", { mode: "steer" });
```

The built-in Agent driver now supports steering in both streaming modes. It
appends input before the next model call, after the entire current tool-call/result
group. Steering during a final model call is incorporated at the next complete
boundary if budgets allow. Effects already completed are not repeated by the
runtime. The model still decides its subsequent actions.

`input.received` means queued. `input.applied` means inserted into the
conversation at a safe boundary; both carry `inputId` and `mode`. Inputs within
each mode preserve FIFO order. `follow_up` remains queued until the current
driver turn completes; `steer` and `follow_up` have different scheduling semantics.
The queue holds at most 32 inputs. Steering rejects once the Agent loop closes,
including while a completion policy is still evaluating. Child agents cannot
consume their parent's steering inbox.

## Public communication

Render these typed events by their stable item IDs:

| Event | Meaning |
| --- | --- |
| `message.started` | Start an item; `phase: "pending"` is explicitly unclassified. |
| `message.delta` | Append text to that item. |
| `message.completed` | The item has phase `commentary`, `final`, or `reasoning_summary`. |
| `message.failed` | A partial item was interrupted or cancelled. |

A `final` message is a model answer, not a terminal runtime result: policies or
queued input may still keep the run open. Only `run.terminal` closes the run.
Standalone native commentary continues the same Agent loop under its existing
budgets. No update schedule, artificial thinking, or progress tool is introduced.

Large completed items use `artifactId` with an empty inline text field; the deltas
remain complete. Retrieve the full `PublicMessage` with
`runtime.getArtifact(identity, sessionId, artifactId)`. Event cursors and the
existing bounded event store retain their normal semantics.

Core consumers can use `RunOutput.publicMessages`, the `run.message` EventBus event,
or opt into `Agent.stream(input, { publicMessageEvents: true })`. The default
stream retains its existing text/finish sequence. Terminal usage and cost data
remain on the final finish chunk, including with public lifecycle chunks enabled.
Legacy `text.delta`, `thinking`, and `RunOutput.text` remain available; prefer
public items when distinguishing progress from answers.

`getCommunicationCapabilities(provider)` reports adapter support:

| Adapter | Message phases | Public summaries |
| --- | --- | --- |
| OpenAI Responses and compatible endpoints implementing these fields | Native when present; otherwise inferred | Documented reasoning summary text |
| Anthropic / AWS Claude with reasoning enabled | Inferred | Text requested with `display: "summarized"` |
| Google / Vertex Gemini | Inferred | Documented thought summary text |
| Other adapters without an explicit capability declaration | Inferred | Unsupported |

`conditional` means support depends on the selected model, endpoint and request
options. It is not a promise that the model emits a summary on every call.
For providers without native phases, a complete response with tools is commentary;
a complete response without tools is final. Unclassified streaming text remains
pending until the response is complete.

Raw reasoning, signatures, encrypted/redacted blocks and `providerExtras` are
never used as public summaries. Opaque data remains in canonical conversation
history for provider replay. Custom adapters should populate `publicMessages`,
`message.phase`, and the corresponding streaming metadata explicitly.

## Compact completed tool rounds

```ts
const contextPolicy = summaryContextPolicy({
  modelRole: "summary",
  maxContextTokens: 12_000,
  grouping: "tool_roundtrip",
  keepRecentTurns: 2, // Here: keep the two latest complete groups.
});
```

Bind and grant the summary model role through `HarnessRuntime.models` and
`grants.modelRoles` as usual. The default grouping remains whole user turns.
The new option recognizes completed tool rounds within a long task, keeps the
latest user request and complete retained tool/replay groups, and summarizes
older groups through the existing summary policy. Applications do not insert
synthetic user turns. Canonical session history is unchanged.

`compaction.started`, `compaction.completed` and `compaction.failed` correlate by
`compactionId` and `policyId`. The summary call shares the run's model/token
budgets and cancellation signal. If an intact live group cannot fit, compaction
fails rather than dropping required continuation data.

Live continuation does not provide process-restart recovery. Events, pending
promises and run handles remain in memory. A future recovery adapter must persist
questions/checkpoints, establish ownership, and reconcile uncertain tool effects.
