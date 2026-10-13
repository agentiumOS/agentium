# Agentium execution

## Language

**Logical model call**: One host-requested model operation, which may cause several provider requests through retries or fallback.

**Provider attempt**: One observable submission to a provider SDK. Its physical request count is opaque when that SDK owns retries.

**Finishing capacity**: A portion of a run's total model-call and token allowance protected for explicitly designated tool-free finishing work. It does not authorize completion.

**Canonical conversation**: The immutable conversation records, whether held resident or referenced in the host archive.

**Resident history**: The conversation records currently retained for local replay. A model request can receive a separate projection of these records.
