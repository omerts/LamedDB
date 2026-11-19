import type { CollectionInfo, FieldMap, JsonObject, RecordEnvelope } from "../types.js";

/** One recorded attempt of a record put. The fingerprint identifies the request. */
export interface IdempotentPut {
  key: string;
  fingerprint: string;
}

export interface PutRecordInput {
  collection: string;
  id: string;
  data: JsonObject;
  createOnly: boolean;
  /** When set, the write proceeds only if the stored version equals this value. */
  ifVersion?: number;
  /**
   * When set, the store either replays the stored result, rejects a different
   * request, or writes and records the result. Those steps are atomic.
   * A failed write is not recorded.
   */
  idempotency?: IdempotentPut;
}

export interface PutRecordResult {
  created: boolean;
  record: RecordEnvelope;
}

/**
 * Persistence port for collection metadata and records.
 * A later engine can replace the in-memory adapter without changing the HTTP API.
 * `putRecord` must apply the write, the createOnly check, the ifVersion check,
 * and any idempotency check-and-record atomically. The version compare and the
 * write must not be split by a yield. The service must not read the version and then write.
 * The key is stored per collection with the request fingerprint and the original result.
 * A failed write is not stored. `deleteRecord` must remove the record and keep
 * the last version for that id. It must not drop idempotency keys. A retry of
 * the original put still returns that result and does not recreate the record.
 * A missing id returns false. A missing collection throws not_found.
 * The next put of a deleted id continues at last version + 1.
 */
export interface Store {
  createCollection(name: string, fields: FieldMap): Promise<CollectionInfo>;

  getCollection(name: string): Promise<CollectionInfo | null>;

  putRecord(input: PutRecordInput): Promise<PutRecordResult>;

  getRecord(collection: string, id: string): Promise<RecordEnvelope | null>;

  deleteRecord(collection: string, id: string): Promise<boolean>;
}
