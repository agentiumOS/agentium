import { createHash } from "node:crypto";
import { bounded, deadline, makeRef, record, route, snapshot, string, validateRef, validateRequest } from "./common.js";
import {
  type CallOperationOptions,
  type CallReference,
  type CallRouteConfig,
  type OutboundCallProvider,
  TelephonyError,
} from "./types.js";

/** Structural subset of livekit-server-sdk SipClient; no SDK import or credentials. */
export interface LiveKitSipCallPort {
  createSipParticipant(
    trunkId: string,
    number: string,
    roomName: string,
    options: { participantIdentity: string; fromNumber: string; waitUntilAnswered: false; hidePhoneNumber: true },
  ): Promise<{
    participantIdentity: string;
    roomName: string;
    sipCallId: string;
  }>;
}
export interface LiveKitCallRoomPort {
  getParticipant(roomName: string, identity: string): Promise<{ identity: string; attributes: Record<string, string> }>;
  removeParticipant(roomName: string, identity: string): Promise<unknown>;
}
export interface LiveKitSipCallConfig extends CallRouteConfig {
  sip: LiveKitSipCallPort;
  rooms: LiveKitCallRoomPort;
  trunkId: string;
  /** Host-owned room. Use one route per room, never accept a caller-supplied room. */
  roomName: string;
  timeoutMs?: number;
}
export function createLiveKitSipCallProvider(config: LiveKitSipCallConfig): OutboundCallProvider {
  const routing = route(config);
  const id = "livekit-sip";
  const { sip, rooms, trunkId, roomName, timeoutMs } = config;
  if (
    !/^[A-Za-z0-9_.:@-]{1,200}$/.test(roomName) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(trunkId) ||
    typeof sip?.createSipParticipant !== "function" ||
    typeof rooms?.getParticipant !== "function" ||
    typeof rooms?.removeParticipant !== "function"
  )
    throw new TelephonyError("invalid-input", "not-dispatched");
  const callRef = (value: CallReference) => {
    const ref = validateRef(value, id, routing.routeId);
    if (ref.roomName !== roomName || !ref.participantIdentity?.startsWith("call-"))
      throw new TelephonyError("invalid-input", "not-dispatched");
    return ref as CallReference & { roomName: string; participantIdentity: string };
  };
  const invoke = async <T>(operation: () => Promise<T>, options?: CallOperationOptions): Promise<T> => {
    const scope = deadline(options, timeoutMs);
    try {
      return await bounded(operation, scope.signal);
    } catch (error) {
      if (error instanceof TelephonyError) throw error;
      throw new TelephonyError("provider-unavailable", "unknown");
    } finally {
      scope.dispose();
    }
  };
  return Object.freeze({
    id,
    routeId: routing.routeId,
    capabilities: Object.freeze({
      transport: "livekit-sip",
      automaticCreateRetry: false,
      callbackVerification: "host",
      hangup: "sip-participant",
    }),
    async create(value, options) {
      const request = validateRequest(value, routing);
      const participantIdentity = `call-${createHash("sha256")
        .update(JSON.stringify([request.identity.tenantId, request.intentId, routing.routeId]))
        .digest("hex")}`;
      const result = await invoke(
        () =>
          sip.createSipParticipant(trunkId, request.to, roomName, {
            participantIdentity,
            fromNumber: request.from,
            waitUntilAnswered: false,
            hidePhoneNumber: true,
          }),
        options,
      );
      if (result.roomName !== roomName || result.participantIdentity !== participantIdentity)
        throw new TelephonyError("invalid-response", "unknown");
      return snapshot({ ...makeRef(id, routing.routeId, result.sipCallId), roomName, participantIdentity }, "queued");
    },
    async get(value, options) {
      const ref = callRef(value);
      const participant = await invoke(() => rooms.getParticipant(roomName, ref.participantIdentity), options);
      if (participant.identity !== ref.participantIdentity || participant.attributes["sip.callID"] !== ref.callId)
        throw new TelephonyError("invalid-response", "unknown");
      return snapshot(ref, participant.attributes["sip.callStatus"]);
    },
    async hangup(value, options) {
      const ref = callRef(value);
      // Verify call binding before removing a participant that could have been replaced.
      await this.get(ref, options);
      await invoke(() => rooms.removeParticipant(roomName, ref.participantIdentity), options);
      return { ref, acknowledged: true };
    },
    normalizeVerifiedEvent(value) {
      const event = record(value);
      const room = record(event.room);
      const participant = record(event.participant);
      const attributes = record(participant.attributes);
      const ref = callRef({
        ...makeRef(id, routing.routeId, attributes["sip.callID"]),
        roomName: string(room.name, 200),
        participantIdentity: string(participant.identity, 200),
      });
      if (attributes["sip.trunkID"] !== trunkId) throw new TelephonyError("invalid-input", "not-dispatched");
      return {
        ...snapshot(ref, event.event === "participant_left" ? "hangup" : attributes["sip.callStatus"]),
        eventId: event.id === undefined ? undefined : string(event.id, 200),
      };
    },
  } satisfies OutboundCallProvider);
}
