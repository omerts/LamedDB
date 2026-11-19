import { LamedError } from "../errors.js";
import type { CollectionInfo, FieldMap, FieldType, JsonObject, RecordEnvelope } from "../types.js";
import type { PutRecordInput, PutRecordResult, Store } from "./store.js";

interface StoredRecord {
  id: string;
  version: number;
  data: JsonObject;
}

/**
 * Process-local store. Suitable for the first API slice and for tests.
 * Record versions are a high-water mark per id so a future delete cannot reuse one.
 */
export class MemoryStore implements Store {
  private readonly collections = new Map<string, CollectionInfo>();

  private readonly records = new Map<string, StoredRecord>();

  private readonly versions = new Map<string, number>();

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
    if (!this.collections.has(input.collection)) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
    }

    const key = recordKey(input.collection, input.id);
    const existing = this.records.get(key);

    if (existing && input.createOnly) {
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

    return {
      created: existing === undefined,
      record: cloneRecord(stored),
    };
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
}

function recordKey(collection: string, id: string): string {
  return `${collection}\0${id}`;
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
