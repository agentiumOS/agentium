# Conversational runs — 4.6.0

Baseline checked 2026-10-09: npm `latest` for core and harness is 4.5.0;
origin/main is 69d135e. That release adds cost accounting, not conversational
suspension, built-in steering, public message lifecycles, or tool-round compaction.

The user supplied acceptance criteria and authorized implementation and a minor
release. These documents make the implementation contract reviewable before code.

| Module id | Responsibility | Depends on |
| --- | --- | --- |
| live-input | Live question/reply lifecycle, cancellation and clocks | — |
| live-steering | Ordered input application at complete exchanges | live-input |
| public-communication | Display messages, summaries, item lifecycle | — |
| compaction-integration | Existing summary policy at completed tool rounds | — |

Build order: live-input → live-steering → public-communication → compaction-integration.
Each module has a SPEC file; implementation and release tasks are in plan.md.

Assumptions: in-process continuation only; one pending question per run; trusted
application owns identity and authorization; questions are voluntary tool calls;
no automatic progress prompting. Existing terminal awaiting_input output remains
legacy-compatible. New requestInput waits are explicitly nonterminal and hold
the session lease. This distinction avoids silently hanging existing run() users.

SDK improvements beyond the original request: reusable core execution ports,
typed reply errors, read-only live run state, bounded question/input payloads,
explicit capability support, and separate active and waiting clocks. No restart
recovery or second compaction engine.
