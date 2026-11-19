import type { CollectionInfo, FieldMap, JsonObject, RecordEnvelope } from "../types.js";

export interface PutRecordInput {
  collection: string;
  id: string;
  data: JsonObject;
  createOnly: boolean;
  /** When set, the write proceeds only if the stored version equals this value. */
  ifVersion?: number;
}

export interface PutRecordResult {
  created: boolean;
  record: RecordEnvelope;
}

/**
 * Persistence port for collection metadata and records.
 * A later engine can replace the in-memory adapter without changing the HTTP API.
 * `putRecord` must apply the write, the createOnly check, and the ifVersion check atomically.
 * The version compare and the write must not be split by a yield. The service must not read the version and then write.
 * `deleteRecord` must remove the record and its version together.
 * A missing id returns false. A missing collection throws not_found.
 * The next put of a deleted id starts at version 1.
 */
export interface Store {
  createCollection(name: string, fields: FieldMap): Promise<CollectionInfo>;

  getCollection(name: string): Promise<CollectionInfo | null>;

  putRecord(input: PutRecordInput): Promise<PutRecordResult>;

  getRecord(collection: string, id: string): Promise<RecordEnvelope | null>;

  deleteRecord(collection: string, id: string): Promise<boolean>;
}
