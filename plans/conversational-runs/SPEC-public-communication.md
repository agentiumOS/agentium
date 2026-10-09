# Spec: public-communication

## Objective
Applications render voluntary commentary, final answers and provider-supported
reasoning summaries without examining opaque replay payloads.

## Contract and style
Normalized public items have stable IDs, phases and text; started/delta/completed/
failed lifecycle events permit in-place UI updates. Pending phase is explicitly
non-final until classification is known. Provider-native phases take priority;
otherwise a response with tool calls is commentary and a concluding response is final.
Public summaries are populated only from documented summary fields; raw thinking,
signatures, redacted/encrypted content are never promoted to summaries.
Explicit commentary-only output continues the loop under existing budgets.
Capability queries distinguish supported/unsupported/provider-dependent behavior.
No forced progress frequency or communication tools.

## Commands, structure and tests
`npm run build`; `npx vitest run packages/core/src/models packages/core/src/agent packages/harness/src`.
Public contracts in models; normalization in provider adapters and core loop;
runtime event forwarding in harness. Use typed named exports.
Test native and fallback phases, stable streaming IDs, summary separation, failure,
cancellation, model/token budgets and accounting. Fake providers need no credentials.

## Boundaries
Always preserve old text/thinking channels for compatibility. Ask before unrelated
provider changes. Never expose opaque providerExtras as public display text.
