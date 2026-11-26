import { LamedError } from "../errors.js";
import type {
  AliasMap,
  CollectionInfo,
  FieldMap,
  FieldType,
  JsonObject,
  RecordEnvelope,
} from "../types.js";
import { assertNoEmbeddedNul, parseMemoryStoreOptions } from "../validate.js";
import type {
  CollectionState,
  IdempotentPut,
  ListRecordsInput,
  ListRecordsResult,
  PutRecordInput,
  PutRecordResult,
  Store,
} from "./store.js";
import { compareRecords, isAfter, matchesFilters } from "./query.js";

interface StoredRecord {
  id: string;
  version: number;
  data: JsonObject;
}

interface IdempotencyEntry {
  fingerprint: string;
  created: boolean;
  record: StoredRecord;
  storedAt: number;
}

export interface MemoryStoreOptions {
  /** Millisecond clock. Tests inject one so expiry does not wait on wall time. */
  now?: () => number;
  /** How long a stored key stays replayable. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** How many keys one collection keeps. The oldest is dropped past this. */
  maxIdempotencyKeys?: number;
}

interface StoredCollection {
  name: string;
  fields: FieldMap;
  aliases: AliasMap;
  revision: number;
}

/**
 * Process-local store. Suitable for the first API slice and for tests.
 * Deleting a record keeps its version counter so the next put of that id continues at last + 1.
 * Idempotency keys are kept per collection and survive that delete.
 * They expire after a TTL, and each collection keeps at most a fixed number of them.
 * Deleting the collection drops its keys, records, and version counters.
 */
export class MemoryStore implements Store {
  private readonly collections = new Map<string, StoredCollection>();

  private readonly records = new Map<string, Map<string, StoredRecord>>();

  private readonly versions = new Map<string, Map<string, number>>();

  private readonly idempotency = new Map<string, Map<string, IdempotencyEntry>>();

  /** Highest storedAt in each collection. Keeps expiry a prefix without scanning. */
  private readonly idempotencyNewestAt = new Map<string, number>();

  private nextRevision = 1;

  private readonly now: () => number;

  private readonly idempotencyTtlMs: number;

  private readonly maxIdempotencyKeys: number;

  constructor(options: MemoryStoreOptions = {}) {
    const retention = parseMemoryStoreOptions(options);

    this.now = retention.now;
    this.idempotencyTtlMs = retention.idempotencyTtlMs;
    this.maxIdempotencyKeys = retention.maxIdempotencyKeys;
  }

  async createCollection(
    name: string,
    fields: FieldMap,
    aliases: AliasMap = {},
  ): Promise<CollectionInfo> {
    if (this.collections.has(name)) {
      throw new LamedError("already_exists", `Collection "${name}" already exists.`);
    }

    const collection: StoredCollection = {
      name,
      fields: cloneFields(fields),
      aliases: cloneAliases(aliases),
      revision: this.nextRevision,
    };

    this.nextRevision += 1;
    this.collections.set(name, collection);

    return cloneCollection(collection);
  }

  async getCollection(name: string): Promise<CollectionState | null> {
    const collection = this.collections.get(name);

    if (!collection) {
      return null;
    }

    return {
      ...cloneCollection(collection),
      revision: collection.revision,
    };
  }

  async deleteCollection(name: string): Promise<boolean> {
    if (!this.collections.delete(name)) {
      return false;
    }

    this.idempotency.delete(name);
    this.idempotencyNewestAt.delete(name);
    this.records.delete(name);
    this.versions.delete(name);

    return true;
  }

  async putRecord(input: PutRecordInput): Promise<PutRecordResult> {
    // applyPut does not await, so the check, the write, and the key record
    // finish before another caller can enter.
    return this.applyPut(input);
  }

  async getRecord(collection: string, id: string): Promise<RecordEnvelope | null> {
    if (!this.collections.has(collection)) {
      return null;
    }

    const stored = this.records.get(collection)?.get(id);

    if (!stored) {
      return null;
    }

    return cloneRecord(stored);
  }

  /**
   * Synchronous on purpose. An await between the idempotency check and the
   * record update would let two puts with the same key both write.
   */
  private applyPut(input: PutRecordInput): PutRecordResult {
    assertNoEmbeddedNul(input.data);

    const collection = this.collections.get(input.collection);

    if (!collection) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
    }

    if (!Number.isSafeInteger(input.collectionRevision) || input.collectionRevision < 0) {
      throw new LamedError("invalid_argument", "Collection revision must be a non-negative safe integer.");
    }

    if (collection.revision !== input.collectionRevision) {
      throw new LamedError(
        "not_found",
        `Collection "${input.collection}" was replaced before the write.`,
      );
    }

    // One clock reading covers the expiry decision and the timestamp stored
    // after a successful write. Nothing between them awaits.
    const idempotency = input.idempotency;
    const now = idempotency === undefined ? undefined : this.readNow();
    const recorded =
      idempotency === undefined || now === undefined
        ? undefined
        : this.liveEntry(input.collection, idempotency.key, now);

    if (idempotency && recorded) {
      if (recorded.fingerprint !== idempotency.fingerprint) {
        throw new LamedError(
          "idempotency_conflict",
          `Idempotency key "${idempotency.key}" was already used for a different request.`,
          { idempotencyKey: idempotency.key },
        );
      }

      return {
        created: recorded.created,
        record: cloneRecord(recorded.record),
      };
    }

    const records = this.bucket(this.records, input.collection);
    const versions = this.bucket(this.versions, input.collection);
    const existing = records.get(input.id);

    // The compare and the two map writes below stay synchronous. An await
    // between them would let a second If-Match on the same version succeed.
    if (input.ifVersion !== undefined && input.createOnly) {
      throw new LamedError("invalid_argument", "If-Match and If-None-Match cannot be used together.");
    }

    if (input.ifVersion !== undefined) {
      if (existing === undefined) {
        throw new LamedError(
          "precondition_failed",
          `Record "${input.id}" was not found in collection "${input.collection}".`,
        );
      }

      if (existing.version !== input.ifVersion) {
        throw new LamedError(
          "precondition_failed",
          `Record "${input.id}" in collection "${input.collection}" is version ${existing.version}, not ${input.ifVersion}.`,
        );
      }
    } else if (existing && input.createOnly) {
      throw new LamedError(
        "precondition_failed",
        `Record "${input.id}" already exists in collection "${input.collection}".`,
      );
    }

    const version = (versions.get(input.id) ?? 0) + 1;
    const stored: StoredRecord = {
      id: input.id,
      version,
      data: structuredClone(input.data),
    };

    versions.set(input.id, version);
    records.set(input.id, stored);

    // The map changes only after the write. A 412 leaves live keys in place,
    // and a failed attempt is not recorded.
    if (idempotency !== undefined && now !== undefined) {
      this.remember(input.collection, idempotency, existing === undefined, stored, now);
    }

    return {
      created: existing === undefined,
      record: cloneRecord(stored),
    };
  }

  async deleteRecord(collection: string, id: string): Promise<boolean> {
    if (!this.collections.has(collection)) {
      throw new LamedError("not_found", `Collection "${collection}" does not exist.`);
    }

    // Leave the version counter in place. The next put continues at last + 1,
    // so an ETag from before this delete cannot match the recreated record.

    return this.records.get(collection)?.delete(id) ?? false;
  }

  /**
   * Synchronous after the lookups, so the scan sees one snapshot. Every page filters and sorts
   * the whole collection, which is fine for this in-memory slice and is the cost an index would remove.
   */
  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    const collection = this.collections.get(input.collection);

    if (!collection || collection.revision !== input.collectionRevision) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
    }

    // Filter, sort and slice the stored records, and copy only the page that is returned.
    const matching: StoredRecord[] = [];

    for (const stored of this.records.get(input.collection)?.values() ?? []) {
      if (matchesFilters(stored, input.filters)) {
        matching.push(stored);
      }
    }

    matching.sort((a, b) => compareRecords(a, b, input.sort));

    const { after } = input;
    const remaining = after === undefined ? matching : matching.filter((record) => isAfter(record, after, input.sort));

    return {
      records: remaining.slice(0, input.limit).map(cloneRecord),
      hasMore: remaining.length > input.limit,
    };
  }

  private bucket<T>(map: Map<string, Map<string, T>>, collection: string): Map<string, T> {
    let inner = map.get(collection);

    if (inner === undefined) {
      inner = new Map();
      map.set(collection, inner);
    }

    return inner;
  }

  private storedAtFor(collection: string, now: number): number {
    const newest = this.idempotencyNewestAt.get(collection);

    // A backwards clock would record this key with an earlier timestamp than a key
    // already in the map. That later key could then expire while the earlier one
    // is still live, and stopping at the first live key would leave it behind.
    // Pin it to the newest stored time so now < storedAt keeps the current keys
    // live together and the next expiry is still a prefix.
    if (newest !== undefined && now < newest) {
      return newest;
    }

    return now;
  }

  private readNow(): number {
    const now = this.now();

    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
      throw new LamedError(
        "internal",
        "Clock must return a non-negative safe integer timestamp in milliseconds.",
      );
    }

    return now;
  }

  private liveEntry(collection: string, key: string, now: number): IdempotencyEntry | undefined {
    const recorded = this.idempotency.get(collection)?.get(key);

    if (recorded === undefined || isExpired(recorded.storedAt, now, this.idempotencyTtlMs)) {
      return undefined;
    }

    return recorded;
  }

  private remember(
    collection: string,
    idempotency: IdempotentPut,
    created: boolean,
    record: StoredRecord,
    now: number,
  ): void {
    let keys = this.idempotency.get(collection);

    if (keys === undefined) {
      keys = new Map();
      this.idempotency.set(collection, keys);
    }

    // Stored times do not decrease, so expired keys are a prefix. Stop at the first live one.
    for (const [key, entry] of keys) {
      if (!isExpired(entry.storedAt, now, this.idempotencyTtlMs)) {
        break;
      }

      keys.delete(key);
    }

    if (keys.size === 0) {
      this.idempotencyNewestAt.delete(collection);
    }

    // Delete first so a reused key is stored as the newest, not left in its old position.
    keys.delete(idempotency.key);

    if (keys.size === 0) {
      this.idempotencyNewestAt.delete(collection);
    }

    const storedAt = this.storedAtFor(collection, now);

    keys.set(idempotency.key, {
      fingerprint: idempotency.fingerprint,
      created,
      record: snapshotRecord(record),
      storedAt,
    });
    this.idempotencyNewestAt.set(collection, storedAt);

    while (keys.size > this.maxIdempotencyKeys) {
      const oldest = keys.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      keys.delete(oldest);
    }
  }
}

function isExpired(storedAt: number, now: number, ttlMs: number): boolean {
  if (now < storedAt) {
    return false;
  }

  return now - storedAt >= ttlMs;
}

function snapshotRecord(record: StoredRecord): StoredRecord {
  return {
    id: record.id,
    version: record.version,
    data: structuredClone(record.data),
  };
}

function cloneFields(fields: FieldMap): FieldMap {
  const copy: Record<string, FieldType> = {};

  for (const [name, type] of Object.entries(fields)) {
    Object.defineProperty(copy, name, {
      value: type,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return copy;
}

function cloneAliases(aliases: AliasMap): AliasMap {
  const copy: Record<string, string> = {};

  for (const [name, target] of Object.entries(aliases)) {
    Object.defineProperty(copy, name, {
      value: target,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return copy;
}

/** The payload callers see. `aliases` appears only when the collection declared some. */
function cloneCollection(collection: CollectionInfo): CollectionInfo {
  const copy: CollectionInfo = {
    name: collection.name,
    fields: cloneFields(collection.fields),
  };

  if (collection.aliases !== undefined && Object.keys(collection.aliases).length > 0) {
    copy.aliases = cloneAliases(collection.aliases);
  }

  return copy;
}

function cloneRecord(record: StoredRecord): RecordEnvelope {
  return {
    id: record.id,
    version: record.version,
    data: structuredClone(record.data),
  };
}
