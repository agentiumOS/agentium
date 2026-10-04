# Outbound telephony

`@agentium/core/telephony` provides an outbound call lifecycle independent of the speech model, voice agent, and carrier. Importing it loads no telephony or LiveKit SDK, creates no client connection, and reads no credentials. Five optional HTTP adapters use an injected `fetch` and authorization resolver; the LiveKit SIP adapter accepts structural SDK ports.

This is call control: create, read, request hangup, normalize a verified status event. It does not implement inbound routing, RTP/WebSocket audio, TwiML/cXML/NCCO generation, a SIP server, number provisioning, transfers, recording, campaigns, or provider callback verification. Connect the configured answer/media route to the application's voice runtime separately.

## Start with an authorized, persisted intent

```ts
import {
  OutboundCallService,
  createTwilioCallProvider,
  type CallIntentStore,
  type CallAuthorization,
} from '@agentium/core/telephony';

function makeCalls(
  store: CallIntentStore,
  authorize: (request: CallAuthorization) => Promise<boolean>,
  authorization: () => Promise<string>,
) {
  return new OutboundCallService({
    store,
    authorize,
    providers: [createTwilioCallProvider({
      routeId: 'support-us-v1',
      allowedFrom: ['+14155550102'],
      accountSid: 'AC_YOUR_ACCOUNT',
      answerUrl: 'https://voice.example.com/answer',
      statusCallbackUrl: 'https://voice.example.com/status',
      authorization, // complete Basic header, resolved from the host's secret store
    })],
  });
}

// `identity` comes from the application's verified authentication boundary.
// `calls` is the service returned above; persist intentId with the business operation.
const record = await calls.create({
  identity: { tenantId: 'tenant-1', userId: 'operator-1' },
  intentId: 'appointment-reminder-2026-10-04-1',
  routeId: 'support-us-v1',
  to: '+14155550101',
  from: '+14155550102',
}, { signal, timeoutMs: 15_000 });

await calls.get(record.request.identity, record.request.intentId);
await calls.hangup(record.request.identity, record.request.intentId);
```

Authorization runs before each operation, including duplicate intent lookup, reads, hangup, reconciliation and event application. It must return exactly `true`. Identity ownership is checked independently; another actor cannot use an existing intent even when the host hook is permissive. The host enforces calling consent, destination/country rules, operating hours, tenant spending/rate limits and permitted routes. Destination and caller ID must be E.164; the caller ID must belong to the route's configured allowlist. Emergency/short codes and caller-supplied URLs, rooms, trunk credentials and arbitrary provider options are rejected.

Route IDs identify immutable host configuration. Version them when changing provider account, instruction URL, trunk or room. The service requires unique route IDs. Low-level provider methods are trusted host ports, not an alternative authenticated HTTP endpoint; expose the service through an authenticated application boundary.

## Dispatch uncertainty and storage

`CallIntentStore.claim` must atomically insert by `(tenantId, intentId)` or return the existing record. `compareAndSet` must atomically replace the expected revision, increment by one, and reject changes to the request, digest or provider. Store records are bounded by the validated schema. Hosts must give storage calls bounded latency and retain unresolved records across crashes and workers. `InMemoryCallIntentStore` is only for local tests/single-process experimentation; it is bounded and refuses capacity overflow instead of silently evicting intents.

An intent is reserved as `dispatching` **before** any call request. Repeating the same input returns the existing record; reusing its ID with another payload conflicts. No state, including `rejected`, permits automatic create replay. The library does not promise exactly-once delivery: a process may stop after the carrier accepted a call but before the response or store update completed.

A network failure, timeout, malformed success response or server error after dispatch leaves creation `unknown`. A definitive client rejection is `rejected`; HTTP 408 remains unknown. A `dispatching` record recovered after a crash is also unresolved. Inspect `getIntent`; do not generate a new intent to “retry” an ambiguous call. The host may establish the original call reference through verified callbacks/provider records, then invoke `reconcile(identity, intentId, ref)`. Reconciliation authorizes the binding and reads that call; it cannot replace a known reference. The library cannot independently prove that an unknown provider call belongs to an original intent, so the host must verify that correspondence.

`signal`/`timeoutMs` bound authorization and each provider request/SDK wait (default 15 seconds, configurable up to 120 seconds). Aborting local work never means the remote call ended. After dispatch, abortion can leave an unknown result. LiveKit SDK promises are observed after timeout but cannot be remotely cancelled by this adapter. Store implementations own their own cancellation and timeouts. Multi-request hangup operations may use more than one request timeout; pass an overall host `AbortSignal` when needed.

`hangup` is a separate authorized effect. Acknowledgment is stored separately and does not change call status to completed. Its dispatch is also reserved; duplicate, uncertain or rejected hangups are not automatically replayed. Reconcile actual state using `get` or a verified event. If a rejected/unknown hangup needs a further attempt, the host must first settle the prior operation and explicitly authorize a low-level adapter request; this initial service does not expose an automatic hangup-reset/retry policy.

## Adapter mappings

| Factory | Host route and authorization | Create / read / hangup |
| --- | --- | --- |
| `createTwilioCallProvider` | `accountSid`, HTTPS `answerUrl`, optional status callback; Basic account/API-key credentials | POST Calls.json; GET Call.json; read status then POST `Status=canceled` for queued/ringing or `completed` for active |
| `createSignalWireCallProvider` | `spaceUrl`, project `accountSid`, HTTPS cXML `answerUrl`; Basic project/token with Voice scope | SignalWire Compatibility Calls resource; same status-update distinction, never DELETE the call record |
| `createTelnyxCallProvider` | `connectionId`, optional HTTPS webhook; Bearer API key | POST `/v2/calls`; GET call status; POST `/actions/hangup` |
| `createVonageCallProvider` | HTTPS NCCO `answerUrl`, optional event URL and official regional `apiOrigin`; short-lived application JWT as Bearer | POST `/v1/calls`; GET UUID; PUT `{action:'hangup'}` |
| `createExotelCallProvider` | `accountSid`, `region`, WSS `streamUrl`, optional callback; Basic API key/token | AgentStream connect; GET Call.json; GET ActiveLegs.json then PUT each scoped leg with `Action=hangup` |
| `createLiveKitSipCallProvider` | `sip` and `rooms` SDK ports, stored `trunkId`, configured `roomName`, caller allowlist | `createSipParticipant`; `getParticipant`; `removeParticipant` |

Twilio uses its [Programmable Voice Call resource](https://www.twilio.com/docs/voice/api/call-resource). SignalWire uses its [Compatibility create API](https://signalwire.com/docs/compatibility-api/rest/calls/create-a-call) and [update API](https://signalwire.com/docs/compatibility-api/rest/calls/update-a-call), not the distinct SWML Calling API. The configured answer endpoint must return the carrier's required instructions.

Telnyx dialing is asynchronous: the initial `is_alive:false` does not mean the call ended. The read API does not distinguish ringing from answered with `is_alive` alone, so the adapter returns `unknown` without stronger evidence. A valid `end_time` with `is_alive:false` establishes an ended call. Use verified initiated/answered/hangup events for richer progress. See [dial](https://developers.telnyx.com/api-reference/call-commands/dial), [hangup](https://developers.telnyx.com/api-reference/call-commands/hangup-call), and the [official SDK read-status contract](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/calls/calls.ts). No provider command-id mechanism is represented as a global exactly-once guarantee.

Vonage phone numbers are sent without the leading `+`; the neutral interface still requires E.164. `answerUrl` points to the host's NCCO response. See the [Voice API](https://developer.vonage.com/en/api/voice), [answer/event URL example](https://developer.vonage.com/en/voice/voice-api/concepts/advanced-machine-detection), and [official SDK hangup implementation](https://github.com/Vonage/vonage-node-sdk/blob/3.x/packages/voice/lib/voice.ts).

Exotel's `From` is the dialed destination and `CallerId` is the owned ExoPhone. AgentStream media uses the configured bidirectional WebSocket. Hangup depends on the account supporting the documented leg-control API; queued calls without active legs remain unresolved, and a partial multi-leg failure remains unknown. The adapter bounds leg enumeration to 16 and verifies each call/account binding before sending updates. It does not fall back to another undocumented endpoint. See [Connect Voice AI](https://developer.exotel.com/docs/agentstream/connect-voice-ai), [call details](https://developer.exotel.com/docs/voice-v1/api-reference/call-details), and [official active-leg/hangup documentation](https://support.exotel.com/support/solutions/articles/3000105981-how-to-perform-listen-whisper-barge-using-lwb-api).

LiveKit uses a configured stored outbound trunk, with any compatible SIP carrier behind it. The host can pass `SipClient` and `RoomServiceClient` from its optional `livekit-server-sdk` dependency. Participant identities are deterministic hashes of tenant/intent/route and expose no phone number. Read/hangup verifies the participant's SIP call ID before acting. A missing participant is not inferred to be a completed call. Removing the SIP participant leaves other room participants intact. The host needs SIP call and room-admin permissions and configures media/dialing/maximum call-duration policy in its trunk/application. See [outbound calls](https://docs.livekit.io/telephony/making-calls/outbound-calls/), [participant attributes](https://docs.livekit.io/reference/telephony/sip-participant/), and [SDK option mapping](https://github.com/livekit/node-sdks/blob/main/packages/livekit-server-sdk/src/SipClient.ts).

## Verified callbacks and normalized state

Call `provider.normalizeVerifiedEvent(payload)` only after the host has verified the provider's signature/token with the original request body, callback URL where required, correct account/application, freshness and replay protection. Then apply the result using `service.applyVerifiedEvent(identity, intentId, event)`. Parsing is not authentication; these methods intentionally expose no unauthenticated callback server. Resolve identity and intent from trusted application state, never the callback's arbitrary metadata.

The input shapes are provider-native parsed values: Twilio/SignalWire form fields (`AccountSid`, `CallSid`, `CallStatus`); Telnyx JSON `data.event_type` and `data.payload`; Vonage JSON (`uuid`, `status`); Exotel status callback fields (`CallSid`, `Status`); LiveKit verified webhook (`event`, `room`, `participant.attributes`). Account/connection/trunk fields are checked when available. Unknown statuses remain unknown. Terminal means ended, not a successful conversation; carrier disposition details beyond the common status set remain outside this initial API.

Only the already-bound reference can update an intent. Terminal status does not regress, and queued/ringing events cannot overwrite active status. The host still deduplicates webhook IDs, verifies event freshness, and records raw audited events separately if needed. Provider references and phone numbers are sensitive application data; protect the intent store and avoid public logs. Returned errors contain fixed codes, outcome and optional HTTP status, never raw response bodies, credential causes, recording URLs or provider error text.

## Evidence and limits

Deterministic fixtures cover each HTTP method/path/body, LiveKit structural SDK arguments, normalized callbacks, ownership, duplicate concurrent intents, crash-window reconstruction, reconciliation, partial/unknown failures, local abort, bounded response reading, safe errors and late promise rejection. These are local contract tests against documented wire shapes, not live PSTN interoperability certification. Test with the chosen account's sandbox and validate callback signing/media configuration before production use. No test places a real outbound call.
