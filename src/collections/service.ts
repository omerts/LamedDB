import { LamedError } from "../errors.js";
import type { Store } from "../storage/store.js";
import type { CollectionInfo, PutOptions, RecordEnvelope } from "../types.js";
import {
  parseCollectionName,
  parseFieldDeclarations,
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

  async putRecord(
    name: string,
    id: string,
    data: unknown,
    options: PutOptions = {},
  ): Promise<PutOutcome> {
    const collectionName = parseCollectionName(name);
    const recordId = parseRecordId(id);
    const collection = await this.requireCollection(collectionName);
    const document = validateDocument(data, collection.fields);

    return this.store.putRecord({
      collection: collectionName,
      id: recordId,
      data: document,
      createOnly: options.createOnly === true,
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

  private async requireCollection(name: string): Promise<CollectionInfo> {
    const collection = await this.store.getCollection(name);

    if (!collection) {
      throw new LamedError("not_found", `Collection "${name}" does not exist.`);
    }

    return collection;
  }
}
