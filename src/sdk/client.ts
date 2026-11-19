import { isErrorCode, LamedError } from "../errors.js";
import type {
  CollectionInfo,
  CollectionSpec,
  JsonObject,
  PutOptions,
  RecordEnvelope,
} from "../types.js";
import { isPlainObject, parseCollectionName, parsePutOptions } from "../validate.js";

export interface LamedDBOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

interface Transport {
  baseUrl: string;
  fetch: typeof fetch;
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

    this.transport = {
      baseUrl: options.baseUrl.replace(/\/$/, ""),
      fetch: options.fetch ?? globalThis.fetch,
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
}

async function createCollection(
  transport: Transport,
  name: string,
  spec?: CollectionSpec,
): Promise<CollectionInfo> {
  const body: { name: string; fields?: CollectionSpec["fields"] } = { name };

  if (spec?.fields !== undefined) {
    body.fields = spec.fields;
  }

  const parsed = await requestJson(transport, "POST", "/v1/collections", body);

  if (!isPlainObject(parsed) || typeof parsed.name !== "string" || !isPlainObject(parsed.fields)) {
    throw new LamedError("internal", "Server returned an unexpected collection payload.");
  }

  return {
    name: parsed.name,
    fields: parsed.fields as CollectionInfo["fields"],
  };
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
  const requestHeaders: Record<string, string> = { ...headers };

  if (body !== undefined) {
    requestHeaders["content-type"] = "application/json";
  }

  const response = await transport.fetch(`${transport.baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? undefined : parseResponseJson(text);

  if (!response.ok) {
    throw errorFromResponse(response.status, parsed);
  }

  return parsed;
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
