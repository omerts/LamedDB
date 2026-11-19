import type { CollectionInfo, FieldMap, JsonObject, RecordEnvelope } from "../types.js";

export interface PutRecordInput {
  collection: string;
  id: string;
  data: JsonObject;
  createOnly: boolean;
}

export interface PutRecordResult {
  created: boolean;
  record: RecordEnvelope;
}

/**
 * Persistence port for collection metadata and records.
 * A later engine can replace the in-memory adapter without changing the HTTP API.
 * `putRecord` must apply the write and the createOnly check atomically.
 */
export interface Store {
  createCollection(name: string, fields: FieldMap): Promise<CollectionInfo>;

  getCollection(name: string): Promise<CollectionInfo | null>;

  putRecord(input: PutRecordInput): Promise<PutRecordResult>;

  getRecord(collection: string, id: string): Promise<RecordEnvelope | null>;
}
