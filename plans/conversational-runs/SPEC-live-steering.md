# Spec: live-steering

## Objective and contract
Built-in agentDriver advertises steer. send(input, { mode: "steer" }) queues input;
the core loop consumes it before the next model call, after complete tool results.
Received and applied events carry the same stable input ID in FIFO order.
Inputs arriving during a final model call are applied at the next complete
boundary before finalizing, subject to the existing run budgets.
Child Agent executions must not consume the parent's inbox.

## Commands, structure and style
`npm run build`; `npx vitest run packages/harness/src`; `npm run lint`.
Optional core takeInput port, runtime queue, LLMLoop boundary. Named exports and
additive contracts. Existing custom-driver takeInput stays usable.

## Testing and success
Defer a tool, enqueue two instructions, release it: both appear after all tool
results in the next request; effects run once. Reject sends after completion,
cancellation and finalization; enforce queue and payload bounds.
Streaming and nonstreaming share the same behavior. No restart or history reset.

## Boundaries
Always append steering to canonical transcript. Ask for unrelated scope changes.
Never inject user messages into an unfinished tool group.
