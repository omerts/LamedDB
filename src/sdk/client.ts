import { isErrorCode, LamedError } from "../errors.js";
import type {
  AliasMap,
  CollectionInfo,
  CollectionSpec,
  FilterScalar,
  JsonObject,
  ListOptions,
  ListResult,
  PutOptions,
  RecordEnvelope,
} from "../types.js";
import { isPlainObject, isValidApiKey, LIMITS, parseCollectionName, parsePutOptions, preview } from "../validate.js";

export interface LamedDBOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

interface Transport {
  baseUrl: string;
  fetch: typeof fetch;
  apiKey: string;
}

export class LamedDB {
  readonly admin: {
    createCollection(name: string, spec?: CollectionSpec): Promise<CollectionInfo>;
    deleteCollection(name: string): Promise<void>;
  };

  private readonly transport: Transport;

  constructor(options: LamedDBOptions) {
    if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new LamedError("invalid_argument", "baseUrl is required.");
    }

    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new LamedError("invalid_argument", "apiKey is required.");
    }

    if (!isValidApiKey(options.apiKey)) {
      throw new LamedError(
        "invalid_argument",
        "apiKey must be printable ASCII with no spaces or control characters.",
      );
    }

    this.transport = {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      fetch: options.fetch ?? globalThis.fetch,
      apiKey: options.apiKey,
    };
    this.admin = {
      createCollection: (name, spec) => createCollection(this.transport, name, spec),
      deleteCollection: (name) => deleteCollection(this.transport, name),
    };
  }

  collection(name: string): CollectionClient {
    return new CollectionClient(this.transport, name);
  }
}

export class CollectionClient {
  constructor(
    private readonly transport: Transport,
    private readonly name: string,
  ) {}

  put(id: string, data: JsonObject, options?: PutOptions): Promise<RecordEnvelope> {
    return putRecord(this.transport, this.name, id, data, options);
  }

  get(id: string): Promise<RecordEnvelope> {
    return getRecord(this.transport, this.name, id);
  }

  delete(id: string): Promise<void> {
    return deleteRecord(this.transport, this.name, id);
  }

  /** One page of records. Pass `nextCursor` back as `cursor` for the next page. */
  list(options?: ListOptions): Promise<ListResult> {
    return listRecords(this.transport, this.name, options);
  }
}

async function createCollection(
  transport: Transport,
  name: string,
  spec?: CollectionSpec,
): Promise<CollectionInfo> {
  const body: { name: string; fields?: CollectionSpec["fields"]; aliases?: CollectionSpec["aliases"] } = { name };

  if (spec?.fields !== undefined) {
    body.fields = spec.fields;
  }

  if (spec?.aliases !== undefined) {
    body.aliases = spec.aliases;
  }

  const parsed = await requestJson(transport, "POST", "/v1/collections", body);

  if (!isPlainObject(parsed) || typeof parsed.name !== "string" || !isPlainObject(parsed.fields)) {
    throw new LamedError("internal", "Server returned an unexpected collection payload.");
  }

  const info: CollectionInfo = {
    name: parsed.name,
    fields: parsed.fields as CollectionInfo["fields"],
  };

  if (isPlainObject(parsed.aliases)) {
    info.aliases = aliasMapFromPayload(parsed.aliases);
  }

  return info;
}

function aliasMapFromPayload(value: Record<string, unknown>): AliasMap {
  const aliases: Record<string, string> = {};

  for (const [name, target] of Object.entries(value)) {
    if (typeof target !== "string") {
      throw new LamedError("internal", "Server returned an unexpected collection payload.");
    }

    Object.defineProperty(aliases, name, {
      value: target,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return aliases;
}

async function deleteCollection(transport: Transport, name: string): Promise<void> {
  const collectionName = parseCollectionName(name);

  await requestJson(transport, "DELETE", `/v1/collections/${encodeURIComponent(collectionName)}`);
}

async function putRecord(
  transport: Transport,
  collection: string,
  id: string,
  data: JsonObject,
  options?: PutOptions,
): Promise<RecordEnvelope> {
  const putOptions = parsePutOptions(options);
  const headers: Record<string, string> = {};

  if (putOptions.createOnly) {
    headers["if-none-match"] = "*";
  }

  if (putOptions.ifVersion !== undefined) {
    headers["if-match"] = `"${putOptions.ifVersion}"`;
  }

  if (putOptions.idempotencyKey !== undefined) {
    headers["idempotency-key"] = putOptions.idempotencyKey;
  }

  const parsed = await requestJson(transport, "PUT", recordPath(collection, id), data, headers);

  return parseEnvelope(parsed);
}

async function getRecord(transport: Transport, collection: string, id: string): Promise<RecordEnvelope> {
  const parsed = await requestJson(transport, "GET", recordPath(collection, id));

  return parseEnvelope(parsed);
}

async function deleteRecord(transport: Transport, collection: string, id: string): Promise<void> {
  await requestJson(transport, "DELETE", recordPath(collection, id));
}

async function requestJson(
  transport: Transport,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const requestHeaders: Record<string, string> = {
    ...headers,
    authorization: `Bearer ${transport.apiKey}`,
  };

  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }

  const init: RequestInit = {
    method,
    headers: requestHeaders,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await transport.fetch(`${transport.baseUrl}${path}`, init);
  const text = await response.text();
  const parsed = text.length === 0 ? undefined : parseResponseJson(text);

  if (!response.ok) {
    throw errorFromResponse(response.status, parsed);
  }

  return parsed;
}

async function listRecords(
  transport: Transport,
  collection: string,
  options?: ListOptions,
): Promise<ListResult> {
  const query = encodeListQuery(options);
  const path = `/v1/collections/${encodeURIComponent(parseCollectionName(collection))}/records`;
  const parsed = await requestJson(transport, "GET", query.length === 0 ? path : `${path}?${query}`);

  if (
    !isPlainObject(parsed) ||
    !Array.isArray(parsed.records) ||
    !(parsed.nextCursor === null || typeof parsed.nextCursor === "string")
  ) {
    throw new LamedError("internal", "Server returned an unexpected list payload.");
  }

  return {
    records: parsed.records.map((record) => parseEnvelope(record)),
    nextCursor: parsed.nextCursor,
  };
}

const RANGE_OPERATORS = ["gt", "gte", "lt", "lte"];
const FILTER_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "prefix"];

/** Check list options at runtime and build the query string. The server checks field names and types. */
function encodeListQuery(options: unknown): string {
  if (options === undefined) {
    return "";
  }

  if (!isPlainObject(options)) {
    throw new LamedError("invalid_argument", "List options must be an object.");
  }

  for (const key of Reflect.ownKeys(options)) {
    if (key !== "limit" && key !== "cursor" && key !== "sort" && key !== "filter") {
      throw new LamedError("invalid_argument", `Unknown list option "${typeof key === "string" ? preview(key) : "symbol"}".`);
    }
  }

  const pairs: [string, string][] = [];
  const { limit, cursor, sort, filter } = options;

  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxListLimit) {
      throw new LamedError("invalid_argument", `limit must be a whole number from 1 to ${LIMITS.maxListLimit}.`);
    }

    pairs.push(["limit", String(limit)]);
  }

  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length === 0) {
      throw new LamedError("invalid_argument", "cursor must be a non-empty string.");
    }

    pairs.push(["cursor", cursor]);
  }

  if (sort !== undefined) {
    if (typeof sort !== "string" || sort.length === 0) {
      throw new LamedError("invalid_argument", "sort must be a non-empty string.");
    }

    pairs.push(["sort", sort]);
  }

  if (filter !== undefined) {
    if (!isPlainObject(filter)) {
      throw new LamedError("invalid_argument", "filter must be an object.");
    }

    let clauses = 0;

    for (const field of Object.keys(filter)) {
      const entry = filter[field];

      if (isPlainObject(entry)) {
        if (Object.keys(entry).length === 0) {
          throw new LamedError(
            "invalid_argument",
            `Filter "${preview(field)}" has no operator. Use a value, or an object such as { gte: 1 }.`,
          );
        }

        for (const op of Object.keys(entry)) {
          if (!FILTER_OPERATORS.includes(op)) {
            throw new LamedError("invalid_argument", `Unknown filter operator "${preview(op)}" on "${preview(field)}".`);
          }

          clauses += 1;
          pairs.push([`filter[${field}][${op}]`, filterText(entry[op], op, `${field}[${op}]`)]);
        }
      } else {
        clauses += 1;
        pairs.push([`filter[${field}]`, filterText(entry, "eq", field)]);
      }
    }

    if (clauses > LIMITS.maxFilterClauses) {
      throw new LamedError(
        "invalid_argument",
        `A list request can have at most ${LIMITS.maxFilterClauses} filter clauses, got ${clauses}.`,
      );
    }
  }

  return pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function filterText(value: unknown, op: string, label: string): string {
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.maxInValues) {
      throw new LamedError(
        "invalid_argument",
        `Filter ${preview(label)} needs an array of 1 to ${LIMITS.maxInValues} values.`,
      );
    }

    return value.map((item) => scalarText(item, label, true)).join(",");
  }

  if (op === "prefix" && (typeof value !== "string" || value.length === 0)) {
    throw new LamedError("invalid_argument", `Filter ${preview(label)} needs a non-empty string prefix.`);
  }

  if (value === null && RANGE_OPERATORS.includes(op)) {
    throw new LamedError("invalid_argument", `Filter ${preview(label)} cannot compare with null.`);
  }

  return scalarText(value, label, false);
}

function scalarText(value: unknown, label: string, inList: boolean): string {
  const scalar = value as FilterScalar;

  if (scalar === null) {
    return "null";
  }

  if (typeof scalar === "number" && Number.isSafeInteger(scalar)) {
    return String(scalar);
  }

  if (typeof scalar === "string" && !(inList && scalar.includes(","))) {
    return scalar;
  }

  throw new LamedError(
    "invalid_argument",
    `Filter ${preview(label)} needs a string, a safe integer, or null${inList ? " (no commas inside a list value)" : ""}.`,
  );
}

function parseEnvelope(parsed: unknown): RecordEnvelope {
  if (
    !isPlainObject(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.version !== "number" ||
    !Number.isInteger(parsed.version) ||
    !isPlainObject(parsed.data)
  ) {
    throw new LamedError("internal", "Server returned an unexpected record payload.");
  }

  return {
    id: parsed.id,
    version: parsed.version,
    data: parsed.data as JsonObject,
  };
}

function errorFromResponse(status: number, body: unknown): LamedError {
  if (
    isPlainObject(body) &&
    isPlainObject(body.error) &&
    typeof body.error.code === "string" &&
    typeof body.error.message === "string" &&
    isErrorCode(body.error.code)
  ) {
    const details = isPlainObject(body.error.details) ? body.error.details : undefined;

    return new LamedError(body.error.code, body.error.message, details);
  }

  return new LamedError("internal", `Request failed with status ${status}.`);
}

function parseResponseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LamedError("internal", "Server returned invalid JSON.");
  }
}

function recordPath(collection: string, id: string): string {
  return `/v1/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`;
}
