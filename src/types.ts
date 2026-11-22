export type FieldType = "string" | "integer" | "timestamp";

export type FieldMap = Readonly<Record<string, FieldType>>;

/** Friendly names for declared fields. `{ amount: "totalCents" }` lets callers filter and sort by `amount`. */
export type AliasMap = Readonly<Record<string, string>>;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** Optional field declarations. Records may still store additional JSON fields. */
export interface CollectionSpec {
  fields?: Readonly<Record<string, FieldType>>;
  /** Alias to declared field. An alias cannot equal a declared field or `id`. */
  aliases?: AliasMap;
}

export interface CollectionInfo {
  name: string;
  fields: FieldMap;
  /** Present only when the collection declared aliases. */
  aliases?: AliasMap;
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

  /**
   * Replace the record only when its current version is this value.
   * On the wire this is `If-Match: "<version>"`.
   * Cannot be combined with `createOnly`.
   */
  ifVersion?: number;

  /**
   * Replay this exact put instead of writing it twice.
   * On the wire this is `Idempotency-Key`.
   * A different put that reuses the key is rejected.
   */
  idempotencyKey?: string;
}

export type FilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "prefix";

/** A filter value as callers write it. `null` matches a null or missing field. */
export type FilterScalar = string | number | null;

export type FilterOperators = {
  [Op in Exclude<FilterOperator, "in">]?: FilterScalar;
} & { in?: readonly FilterScalar[] };

export interface ListOptions {
  /** 1 to 100. Default 50. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** `field` ascending or `-field` descending. `id`, integer and timestamp fields (or their aliases). */
  sort?: string;
  /** Equality shorthand (`{ status: "paid" }`) or operators (`{ totalCents: { gte: 1000 } }`). Clauses are ANDed. */
  filter?: Readonly<Record<string, FilterScalar | FilterOperators>>;
}

export interface ListResult {
  records: RecordEnvelope[];
  /** `null` on the last page. */
  nextCursor: string | null;
}
