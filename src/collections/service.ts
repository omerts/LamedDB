import { Router, routerForStore, type ResolvedRoute } from "../engine/router.js";
import type { EngineOperation, EngineStore } from "../engine/registry.js";
import { LamedError } from "../errors.js";
import { encodeCursor, parseListQuery } from "./list-query.js";
import { fieldValue } from "../storage/query.js";
import type { CollectionState, IdempotentPut, Store } from "../storage/store.js";
import type { CollectionInfo, JsonObject, JsonValue, ListResult, PutOptions, RecordEnvelope } from "../types.js";
import {
  isPlainObject,
  parseAliasDeclarations,
  parseCollectionName,
  parseFieldDeclarations,
  parsePutOptions,
  parseRecordId,
  preview,
  validateDocument,
} from "../validate.js";

export interface PutOutcome {
  created: boolean;
  record: RecordEnvelope;
}

/** Debug hook for the route a use case pinned. It is not part of the HTTP response. */
export interface CollectionServiceOptions {
  onRoute?: (route: ResolvedRoute) => void;
}

const SERVICE_OPTION_FIELDS = new Set(["onRoute"]);

/**
 * Collection use cases shared by HTTP and any later in-process entry point.
 * Transport concerns (paths, headers, status codes) stay in the HTTP layer.
 * Each use case resolves one route and stays on that store, so the collection
 * read and the following put or list share one pinned generation.
 */
export class CollectionService {
  private readonly router: Router;

  private readonly onRoute: ((route: ResolvedRoute) => void) | undefined;

  constructor(backend: Store | Router, options?: CollectionServiceOptions) {
    const parsed = parseServiceOptions(options);

    if (backend instanceof Router) {
      this.router = backend;
    } else {
      this.router = routerForStore(backend);
    }

    this.onRoute = parsed.onRoute;
  }

  async createCollection(
    name: string,
    spec: { fields?: unknown; aliases?: unknown } = {},
  ): Promise<CollectionInfo> {
    const collectionName = parseCollectionName(name);
    const fields = parseFieldDeclarations(spec.fields);
    const aliases = parseAliasDeclarations(spec.aliases, fields);

    const route = this.open("createCollection", collectionName);

    return requireMethod(route, "createCollection")(collectionName, fields, aliases);
  }

  async deleteCollection(name: string): Promise<void> {
    const collectionName = parseCollectionName(name);

    const route = this.open("deleteCollection", collectionName);
    const deleted = await requireMethod(route, "deleteCollection")(collectionName);

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

    const route = this.open("putRecord", collectionName, ["getCollection"]);
    const collection = await this.requireCollection(route, collectionName);

    const document = validateDocument(data, collection.fields);
    const idempotency = idempotentPut(putOptions, recordId, document);

    return requireMethod(route, "putRecord")({
      collection: collectionName,
      id: recordId,
      data: document,
      createOnly: putOptions.createOnly,
      collectionRevision: collection.revision,
      ...(putOptions.ifVersion !== undefined ? { ifVersion: putOptions.ifVersion } : {}),
      ...(idempotency !== undefined ? { idempotency } : {}),
    });
  }

  async getRecord(name: string, id: string): Promise<RecordEnvelope> {
    const collectionName = parseCollectionName(name);
    const recordId = parseRecordId(id);

    const route = this.open("getRecord", collectionName, ["getCollection"]);

    await this.requireCollection(route, collectionName);

    const record = await requireMethod(route, "getRecord")(collectionName, recordId);

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

    const route = this.open("deleteRecord", collectionName, ["getCollection"]);

    await this.requireCollection(route, collectionName);

    const deleted = await requireMethod(route, "deleteRecord")(collectionName, recordId);

    if (!deleted) {
      throw new LamedError(
        "not_found",
        `Record "${recordId}" was not found in collection "${collectionName}".`,
      );
    }
  }

  /**
   * One page of records. `options` is the wire form: `limit`, `cursor`, `sort`, and `filter`
   * as strings (see `parseListQuery`). Records come back in the sort order and the cursor
   * holds the last position, so nothing is remembered between pages.
   */
  async listRecords(name: string, options?: unknown): Promise<ListResult> {
    const collectionName = parseCollectionName(name);

    const route = this.open("listRecords", collectionName, ["getCollection"]);
    const collection = await this.requireCollection(route, collectionName);
    const query = parseListQuery(options, collection);

    const page = await requireMethod(route, "listRecords")({
      collection: collectionName,
      collectionRevision: collection.revision,
      filters: query.filters,
      sort: query.sort,
      limit: query.limit,
      ...(query.after !== undefined ? { after: query.after } : {}),
    });
    const last = page.records[page.records.length - 1];

    return {
      records: page.records,
      nextCursor:
        page.hasMore && last !== undefined
          ? encodeCursor(collection, query, { id: last.id, value: fieldValue(last, query.sort.field) ?? null })
          : null,
    };
  }

  private open(
    operation: EngineOperation,
    collection: string,
    also: readonly EngineOperation[] = [],
  ): ResolvedRoute {
    const route = this.router.resolve({
      operation,
      collection,
      scope: "default",
      consistency: "strong",
    });

    for (const required of [operation, ...also]) {
      if (!route.operations.includes(required)) {
        throw new LamedError("internal", `No qualified route for operation "${required}".`, {
          operation: required,
        });
      }
    }

    this.onRoute?.(route);

    return route;
  }

  private async requireCollection(route: ResolvedRoute, name: string): Promise<CollectionState> {
    const collection = await requireMethod(route, "getCollection")(name);

    if (!collection) {
      throw new LamedError("not_found", `Collection "${name}" does not exist.`);
    }

    return collection;
  }
}

function requireMethod<K extends EngineOperation>(
  route: ResolvedRoute,
  operation: K,
): NonNullable<EngineStore[K]> {
  const method = route.store[operation];

  if (!route.operations.includes(operation) || typeof method !== "function") {
    throw new LamedError("internal", `No qualified route for operation "${operation}".`, {
      operation,
    });
  }

  return method.bind(route.store) as NonNullable<EngineStore[K]>;
}

function parseServiceOptions(options: unknown): CollectionServiceOptions {
  if (options === undefined) {
    return {};
  }

  if (!isPlainObject(options)) {
    throw new LamedError("invalid_argument", "Collection service options must be an object.");
  }

  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !SERVICE_OPTION_FIELDS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown service option "${optionName(key)}".`);
    }
  }

  if (options.onRoute !== undefined && typeof options.onRoute !== "function") {
    throw new LamedError("invalid_argument", "onRoute must be a function.", { parameter: "onRoute" });
  }

  if (typeof options.onRoute !== "function") {
    return {};
  }

  return { onRoute: options.onRoute as (route: ResolvedRoute) => void };
}

function optionName(key: string | symbol): string {
  if (typeof key === "string") {
    return preview(key);
  }

  return preview(key.description ?? "symbol");
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
