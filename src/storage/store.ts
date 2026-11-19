import type { CollectionInfo, FieldMap, JsonObject, RecordEnvelope } from "../types.js";

/** One recorded attempt of a record put. The fingerprint identifies the request. */
export interface IdempotentPut {
  key: string;
  fingerprint: string;
}

/** A collection plus the identity of this particular time it was created. */
export interface CollectionState extends CollectionInfo {
  revision: number;
}

export interface PutRecordInput {
  collection: string;
  id: string;
  data: JsonObject;
  createOnly: boolean;
  /**
   * The `revision` from the `getCollection` result the document was checked against.
   * The write fails when that collection has since been replaced.
   */
  collectionRevision: number;
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
 * the idempotency expiry check, and any key record in that one call. The version
 * compare and the write must not be split by a yield. The service must not read
 * the version, or decide that a key is live, and then write.
 * `putRecord` must reject the write when `collectionRevision` is not the revision
 * currently stored for that name, so a document checked against one collection
 * cannot land in a later collection created with the same name.
 * The key is stored per collection with the request fingerprint and the original result.
 * A live key with the same fingerprint returns that result and does not write.
 * A live key with a different fingerprint throws idempotency_conflict and does not write.
 * An expired or evicted key is absent, so the request is processed again.
 * A failed write is not stored and does not evict a live key.
 * When a successful record would exceed the collection's key cap, the oldest stored
 * key is dropped. Replaying a key does not make it newer.
 * `deleteRecord` must remove the record and keep the last version for that id.
 * It must not drop idempotency keys. A retry of the original put still returns
 * that result and does not recreate the record. A missing id returns false.
 * A missing collection throws not_found. The next put of a deleted id continues
 * at last version + 1.
 * `deleteCollection` removes the collection, its records, its version counters,
 * and its idempotency keys, and only those. A missing collection returns false.
 * `getCollection` returns the current revision. `createCollection` does not
 * include that revision in the collection payload.
 */
export interface Store {
  createCollection(name: string, fields: FieldMap): Promise<CollectionInfo>;

  getCollection(name: string): Promise<CollectionState | null>;

  deleteCollection(name: string): Promise<boolean>;

  putRecord(input: PutRecordInput): Promise<PutRecordResult>;

  getRecord(collection: string, id: string): Promise<RecordEnvelope | null>;

  deleteRecord(collection: string, id: string): Promise<boolean>;
}
