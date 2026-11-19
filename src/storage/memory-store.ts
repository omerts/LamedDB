import { LamedError } from "../errors.js";
import type { CollectionInfo, FieldMap, FieldType, JsonObject, RecordEnvelope } from "../types.js";
import { parseMemoryStoreOptions } from "../validate.js";
import type { IdempotentPut, PutRecordInput, PutRecordResult, Store } from "./store.js";

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

/**
 * Process-local store. Suitable for the first API slice and for tests.
 * Deleting a record keeps its version counter so the next put of that id continues at last + 1.
 * Idempotency keys are kept per collection and survive that delete.
 * They expire after a TTL, and each collection keeps at most a fixed number of them.
 * Deleting the collection drops its keys.
 */
export class MemoryStore implements Store {
  private readonly collections = new Map<string, CollectionInfo>();

  private readonly records = new Map<string, StoredRecord>();

  private readonly versions = new Map<string, number>();

  private readonly idempotency = new Map<string, Map<string, IdempotencyEntry>>();

  private readonly now: () => number;

  private readonly idempotencyTtlMs: number;

  private readonly maxIdempotencyKeys: number;

  constructor(options: MemoryStoreOptions = {}) {
    const retention = parseMemoryStoreOptions(options);

    this.now = retention.now;
    this.idempotencyTtlMs = retention.idempotencyTtlMs;
    this.maxIdempotencyKeys = retention.maxIdempotencyKeys;
  }

  async createCollection(name: string, fields: FieldMap): Promise<CollectionInfo> {
    if (this.collections.has(name)) {
      throw new LamedError("already_exists", `Collection "${name}" already exists.`);
    }

    const collection: CollectionInfo = {
      name,
      fields: cloneFields(fields),
    };

    this.collections.set(name, collection);

    return cloneCollection(collection);
  }

  async getCollection(name: string): Promise<CollectionInfo | null> {
    const collection = this.collections.get(name);

    if (!collection) {
      return null;
    }

    return cloneCollection(collection);
  }

  async deleteCollection(name: string): Promise<boolean> {
    if (!this.collections.delete(name)) {
      return false;
    }

    this.idempotency.delete(name);
    deletePrefixed(this.records, name);
    deletePrefixed(this.versions, name);

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

    const stored = this.records.get(recordKey(collection, id));

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
    if (!this.collections.has(input.collection)) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
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

    const key = recordKey(input.collection, input.id);
    const existing = this.records.get(key);

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

    const version = (this.versions.get(key) ?? 0) + 1;
    const stored: StoredRecord = {
      id: input.id,
      version,
      data: structuredClone(input.data),
    };

    this.versions.set(key, version);
    this.records.set(key, stored);

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

    const key = recordKey(collection, id);

    // Leave the version counter in place. The next put continues at last + 1,
    // so an ETag from before this delete cannot match the recreated record.

    return this.records.delete(key);
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

    const expired: string[] = [];

    for (const [key, entry] of keys) {
      if (isExpired(entry.storedAt, now, this.idempotencyTtlMs)) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      keys.delete(key);
    }

    // Delete first so a reused key is stored as the newest, not left in its old position.
    keys.delete(idempotency.key);
    keys.set(idempotency.key, {
      fingerprint: idempotency.fingerprint,
      created,
      record: snapshotRecord(record),
      storedAt: now,
    });

    while (keys.size > this.maxIdempotencyKeys) {
      const oldest = keys.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      keys.delete(oldest);
    }
  }
}

function recordKey(collection: string, id: string): string {
  return `${collection}\0${id}`;
}

function isExpired(storedAt: number, now: number, ttlMs: number): boolean {
  if (now < storedAt) {
    return false;
  }

  return now - storedAt >= ttlMs;
}

function deletePrefixed<T>(map: Map<string, T>, collection: string): void {
  const prefix = `${collection}\0`;

  for (const key of [...map.keys()]) {
    if (key.startsWith(prefix)) {
      map.delete(key);
    }
  }
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

function cloneCollection(collection: CollectionInfo): CollectionInfo {
  return {
    name: collection.name,
    fields: cloneFields(collection.fields),
  };
}

function cloneRecord(record: StoredRecord): RecordEnvelope {
  return {
    id: record.id,
    version: record.version,
    data: structuredClone(record.data),
  };
}
