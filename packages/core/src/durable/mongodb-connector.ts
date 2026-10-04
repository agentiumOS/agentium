import type { DurableActionConnector } from "./actions.js";
import { durableCanonical } from "./store.js";
import { type DurableAction, DurableConflictError } from "./types.js";
/** Host-owned Mongo collection; callers configure majority+journal acknowledgement. */
export interface DurableDocumentCollection {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}
/** Append-only Mongo document effect with an atomic unique _id and readable receipt.
 * Destination is host-bound. It does not provide email/payment idempotency.
 */
export class MongoDBDurableDocumentConnector implements DurableActionConnector {
  readonly version = "mongodb-document@1";
  constructor(
    private collection: DurableDocumentCollection,
    private destination: string,
  ) {}
  private check(action: Readonly<DurableAction>): void {
    if (action.destination !== this.destination || action.connectorVersion !== this.version)
      throw new DurableConflictError("Mongo document destination/version is not authorized");
    if (Buffer.byteLength(durableCanonical(action.args)) > 1_000_000)
      throw new DurableConflictError("Mongo document effect exceeds byte limit");
  }
  async dispatch(action: Readonly<DurableAction>, signal?: AbortSignal): Promise<{ resultRef: string }> {
    this.check(action);
    signal?.throwIfAborted();
    const receipt = { _id: action.idempotencyKey, preparedHash: action.preparedHash, value: action.args };
    try {
      await this.collection.updateOne(
        { _id: action.idempotencyKey },
        { $setOnInsert: receipt },
        { upsert: true, writeConcern: { w: "majority", j: true } },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const stored = await this.collection.findOne({ _id: action.idempotencyKey });
    if (!stored || stored.preparedHash !== action.preparedHash)
      throw new DurableConflictError("Idempotency receipt conflicts with prepared action");
    return { resultRef: `mongodb-document:${action.idempotencyKey}` };
  }
  async reconcile(
    action: Readonly<DurableAction>,
  ): Promise<
    { outcome: "confirmed"; resultRef: string; evidenceRef: string } | { outcome: "unknown"; evidenceRef: string }
  > {
    this.check(action);
    const receipt = await this.collection.findOne({ _id: action.idempotencyKey });
    if (receipt?.preparedHash === action.preparedHash)
      return {
        outcome: "confirmed",
        resultRef: `mongodb-document:${action.idempotencyKey}`,
        evidenceRef: `mongodb-receipt:${action.idempotencyKey}`,
      };
    // Absence alone does not rule out an earlier request arriving late.
    return { outcome: "unknown", evidenceRef: `mongodb-lookup:${action.idempotencyKey}` };
  }
}
