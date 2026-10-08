# Cost accounting DX audit

Date: 2026-10-08. Release target: 4.5.0, as requested by the user.

Scope: Fix; cost-related Agent, Team, Workflow, stream results, configuration, public accounting types, errors, lifecycle, and package entry points. Rules: `api-`, `types-`, `err-`, `config-`, and reached `onboard-` rules. CLI and unrelated package features are outside this audit.

## Findings and changes

1. **CRITICAL — `api-sensible-defaults`: common calls required manual coordination.** The first cost example created a tracker, wrapped a function, flushed writes, queried a session, and repeated cleanup. Agent accounting now has one constructor setting, `cost: true`, and a run-level `costs` snapshot. The same contract applies to terminal stream chunks and to Team and Workflow results. Shared trackers remain an advanced option. Accounting stays opt-in.
2. **CRITICAL — `api-predictable-return-shape`: an accounting read failure could lose a successful answer.** Run snapshots distinguish `available` from `unavailable`. Missing prices and missing reads keep `total: null`; a failed read does not invent a known subtotal or repeat the model call. Disabled tracking leaves the optional snapshot absent.
3. **CRITICAL — `api-no-hidden-side-effects`: ownership and nested scope needed explicit rules.** Parent tracking cannot be bypassed by a child setting. A run snapshot includes only that run's descendants, not its siblings. Agent-owned trackers drain at close. Supplied trackers and stores remain caller-owned. Semantic cache hits must not repeat a prior charge.
4. **CRITICAL — `err-stable-error-codes`, `err-suggest-the-fix`: error text was insufficient for recovery.** Accounting conflicts and persistence failures now expose stable codes and tell callers to retry accounting writes, not successful provider work. Public compatibility and budget errors also have stable codes. Configuration conflicts fail at construction.
5. **MEDIUM — `config-optional-with-defaults`: valid tariffs were inaccessible without manual context construction.** `billingContext` supplies trusted account facts once. Provider-returned facts win. It cannot forge provider, model, time, or request identity and does not choose an execution tier. Simple USD thresholds use the existing `maxCostPerRun` shorthand; shared reservations still require explicit scope, period, and bounds.

Public result/configuration hover documentation and the first-run examples are reviewed under **HIGH — `types-public-jsdoc`** and **HIGH — `onboard-zero-config-quickstart`**. The docs lead with normal calls, then introduce storage, custom tariffs, groups, and reconciliation.

## Compatibility decision

The user explicitly selected 4.5.0. Existing method names and signatures remain available. Canonical token semantics correct previous double counts. Legacy synchronous history methods reject canonical records rather than returning an incomplete zero; the migration guide states this observable change. This is a documented compatibility limit, not a claim that all old cost consumers need no migration.

## Package import finding

**HIGH — `onboard-exports-resolve-typed`: CommonJS consumers received ESM declarations.** All ten packages now emit a separate `.d.cts` graph, with conditional type exports. The conversion changes local module references only; it preserves external imports and string literal types. Packed consumers and `publint --strict` / `attw --profile node16` pass for all ten packages. The profile covers modern Node ESM/CommonJS and bundler resolution; it does not claim legacy Node10 module resolution support.

## Verification

- `npm run build`: all ten packages passed.
- `tsc --noEmit` for each of the ten package configurations: passed.
- `npx biome ci .`: 672 files passed without warnings.
- Full `npm test` with Redis, MongoDB, PostgreSQL, packed consumers, sandbox SDKs, OpenTelemetry, and native LiveKit enabled: 2,383 passed across 226 files. One optional downloaded Transformers-model test was skipped; its implementation is unchanged.
- `npm run test:package`: both packed consumer suites passed, including the public cost types and the simple Agent path.
- `node --test scripts/release-lock.test.mjs scripts/cjs-declarations.test.mjs`: four passed.
- Optional sandbox SDK and host OpenTelemetry conformance on Node24: three passed. Native LiveKit audio capture/clear also passed locally without a room connection.
- Docs: 307 complete examples type-checked; 693 static imports, 26 adapters / 29 exports, 810 core/transport/queue exports, and 117 harness exports verified.
- Docs build, page links, seven executed recipes, four harness fixtures, queue smoke, and seven reproducible archives passed.
- The documented synthetic four-charge example executed and returned `0.072` with distinct ordinary input, cache read, cache write, and output charges.

Release CI, npm publication, and deployed docs are separate final gates. Do not infer publication from these local results.
