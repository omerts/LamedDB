import { LamedError } from "../errors.js";
import type { CollectionState, IdempotentPut, Store } from "../storage/store.js";
import type { CollectionInfo, JsonObject, JsonValue, PutOptions, RecordEnvelope } from "../types.js";
import {
  parseCollectionName,
  parseFieldDeclarations,
  parsePutOptions,
  parseRecordId,
  validateDocument,
} from "../validate.js";

export interface PutOutcome {
  created: boolean;
  record: RecordEnvelope;
}

/**
 * Collection use cases shared by HTTP and any later in-process entry point.
 * Transport concerns (paths, headers, status codes) stay in the HTTP layer.
 */
export class CollectionService {
  constructor(private readonly store: Store) {}

  async createCollection(name: string, spec: { fields?: unknown } = {}): Promise<CollectionInfo> {
    const collectionName = parseCollectionName(name);
    const fields = parseFieldDeclarations(spec.fields);

    return this.store.createCollection(collectionName, fields);
  }

  async deleteCollection(name: string): Promise<void> {
    const collectionName = parseCollectionName(name);
    const deleted = await this.store.deleteCollection(collectionName);

    if (!deleted) {
      throw new LamedError("not_found", `Collection "${collectionName}" does not exist.`);
    }
  }

  async putRecord(
    name: string,
    id: string,
    data: unknown,
    options: PutOptions = {},
  ): Promise<PutOutcome> {
    const putOptions = parsePutOptions(options);
    const collectionName = parseCollectionName(name);
    const recordId = parseRecordId(id);

    const collection = await this.requireCollection(collectionName);
    const document = validateDocument(data, collection.fields);
    const idempotency = idempotentPut(putOptions, recordId, document);

    return this.store.putRecord({
      collection: collectionName,
      id: recordId,
      data: document,
      createOnly: putOptions.createOnly,
      collectionRevision: collection.revision,
      ifVersion: putOptions.ifVersion,
      idempotency,
    });
  }

  async getRecord(name: string, id: string): Promise<RecordEnvelope> {
    const collectionName = parseCollectionName(name);
    const recordId = parseRecordId(id);

    await this.requireCollection(collectionName);

    const record = await this.store.getRecord(collectionName, recordId);

    if (!record) {
      throw new LamedError(
        "not_found",
        `Record "${recordId}" was not found in collection "${collectionName}".`,
      );
    }

    return record;
  }

  async deleteRecord(name: string, id: string): Promise<void> {
    const collectionName = parseCollectionName(name);
    const recordId = parseRecordId(id);

    await this.requireCollection(collectionName);

    const deleted = await this.store.deleteRecord(collectionName, recordId);

    if (!deleted) {
      throw new LamedError(
        "not_found",
        `Record "${recordId}" was not found in collection "${collectionName}".`,
      );
    }
  }

  private async requireCollection(name: string): Promise<CollectionState> {
    const collection = await this.store.getCollection(name);

    if (!collection) {
      throw new LamedError("not_found", `Collection "${name}" does not exist.`);
    }

    return collection;
  }
}

function idempotentPut(
  options: { idempotencyKey?: string; createOnly: boolean; ifVersion?: number },
  id: string,
  data: JsonObject,
): IdempotentPut | undefined {
  if (options.idempotencyKey === undefined) {
    return undefined;
  }

  return {
    key: options.idempotencyKey,
    fingerprint: fingerprintRecordWrite({
      id,
      data,
      createOnly: options.createOnly,
      ifVersion: options.ifVersion,
    }),
  };
}

/**
 * Canonical request identity. Object key order is not part of the request.
 * Every option that changes the write belongs in this payload, including ifVersion.
 */
function fingerprintRecordWrite(input: {
  id: string;
  data: JsonObject;
  createOnly: boolean;
  ifVersion: number | undefined;
}): string {
  const payload: JsonObject = {
    id: input.id,
    data: input.data,
    createOnly: input.createOnly,
    ifVersion: input.ifVersion ?? null,
  };

  return stableStringify(payload);
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const parts: string[] = [];

  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !("value" in descriptor)) {
      throw new LamedError("internal", "Idempotency fingerprint is missing a value.");
    }

    parts.push(`${JSON.stringify(key)}:${stableStringify(descriptor.value as JsonValue)}`);
  }

  return `{${parts.join(",")}}`;
}
