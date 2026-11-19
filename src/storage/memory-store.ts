import { LamedError } from "../errors.js";
import type { CollectionInfo, FieldMap, FieldType, JsonObject, RecordEnvelope } from "../types.js";
import type { PutRecordInput, PutRecordResult, Store } from "./store.js";

interface StoredRecord {
  id: string;
  version: number;
  data: JsonObject;
}

interface IdempotencyEntry {
  fingerprint: string;
  created: boolean;
  record: StoredRecord;
}

/**
 * Process-local store. Suitable for the first API slice and for tests.
 * Deleting a record keeps its version counter so the next put of that id continues at last + 1.
 * Idempotency keys are kept per collection and survive that delete.
 */
export class MemoryStore implements Store {
  private readonly collections = new Map<string, CollectionInfo>();

  private readonly records = new Map<string, StoredRecord>();

  private readonly versions = new Map<string, number>();

  private readonly idempotency = new Map<string, IdempotencyEntry>();

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

    const idempotency = input.idempotency;
    const idempotencyKey = idempotency
      ? idempotencyStorageKey(input.collection, idempotency.key)
      : undefined;
    const recorded = idempotencyKey === undefined ? undefined : this.idempotency.get(idempotencyKey);

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

    if (idempotency && idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, {
        fingerprint: idempotency.fingerprint,
        created: existing === undefined,
        record: snapshotRecord(stored),
      });
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
}

function recordKey(collection: string, id: string): string {
  return `${collection}\0${id}`;
}

function idempotencyStorageKey(collection: string, key: string): string {
  return `${collection}\0idempotency\0${key}`;
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
