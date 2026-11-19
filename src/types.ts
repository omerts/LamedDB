export type FieldType = "string" | "integer" | "timestamp";

export type FieldMap = Readonly<Record<string, FieldType>>;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Optional field declarations. Records may still store additional JSON fields. */
export interface CollectionSpec {
  fields?: Readonly<Record<string, FieldType>>;
}

export interface CollectionInfo {
  name: string;
  fields: FieldMap;
}

export interface RecordEnvelope {
  id: string;
  version: number;
  data: JsonObject;
}

export interface PutOptions {
  /**
   * Fail when the record id already exists.
   * On the wire this is `If-None-Match: *`.
   */
  createOnly?: boolean;
}
