import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CollectionService } from "../collections/service.js";
import { LamedError } from "../errors.js";
import { MemoryStore } from "../storage/memory-store.js";
import type { Store } from "../storage/store.js";
import { isPlainObject, parseApiKeys, parseIdempotencyKey } from "../validate.js";
import { OversizedBodyError, readJsonBody, readLimitedBody } from "./body.js";

const HEALTH_PATH = "/health";
const RECORD_PATH = /^\/v1\/collections\/([^/]+)\/records\/([^/]+)$/;
const COLLECTION_PATH = /^\/v1\/collections\/([^/]+)$/;

export interface ListenOptions {
  port?: number;
  host?: string;
  store?: Store;
  service?: CollectionService;
  /**
   * At least one API key. The server refuses to start when this is missing or empty.
   * There is no switch that turns authentication off.
   */
  apiKeys: readonly string[];
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

interface HttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export async function listen(options: ListenOptions): Promise<RunningServer> {
  const settings = requireListenOptions(options);
  const apiKeys = parseApiKeys(settings.apiKeys);
  const service = settings.service ?? new CollectionService(settings.store ?? new MemoryStore());
  const server = createServer((req, res) => {
    void handleRequest(req, res, service, apiKeys);
  });
  const host = settings.host ?? "127.0.0.1";
  const port = settings.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected the server to bind a TCP port.");
  }

  return {
    url: `http://${formatHost(address.address)}:${address.port}`,
    host: address.address,
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
        // Drop idle keep-alive sockets so shutdown does not wait on them.
        server.closeAllConnections();
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: CollectionService,
  apiKeys: readonly string[],
): Promise<void> {
  try {
    const result = await route(req, service, apiKeys);
    writeJson(res, result.status, result.body, result.headers);
  } catch (error) {
    if (error instanceof LamedError) {
      const headers: Record<string, string> = {};
      const closeAfterResponse =
        error instanceof OversizedBodyError ||
        error instanceof UnreadBodyError ||
        error.code === "unauthenticated";

      if (error.code === "unauthenticated") {
        headers["www-authenticate"] = "Bearer";
      }

      if (closeAfterResponse) {
        headers.connection = "close";
      }

      writeJson(res, error.status, error.toJSON(), headers, () => {
        // The 401 is already flushed. Drop the socket so an unread body cannot stall it.
        if (closeAfterResponse && !req.destroyed) {
          req.destroy();
        }
      });

      return;
    }

    console.error(error);
    const internal = new LamedError("internal", "Internal server error.");
    writeJson(res, internal.status, internal.toJSON());
  }
}

async function route(
  req: IncomingMessage,
  service: CollectionService,
  apiKeys: readonly string[],
): Promise<HttpResult> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  // Liveness probe for load balancers and uptime checks. This is the only route that skips the key.
  // Only GET skips it. Every other method on /health needs a key, then gets 405.
  if (path === HEALTH_PATH && method === "GET") {
    // Body first: it is the one 400 that closes the socket, so a bad header plus a body also closes it.
    rejectUnreadBody(req);
    rejectUnexpectedQuery(url);
    rejectIfMatch(req);
    rejectIdempotencyKey(req);
    rejectIfNoneMatch(req, "If-None-Match is not supported on this request.");

    return { status: 200, body: { status: "ok" } };
  }

  requireBearer(req, apiKeys);

  if (path === HEALTH_PATH) {
    return methodNotAllowed(["GET"]);
  }

  if (path === "/v1/collections") {
    rejectUnexpectedQuery(url);

    if (method !== "POST") {
      rejectIfMatch(req);
      rejectIdempotencyKey(req);
      rejectIfNoneMatch(req, "If-None-Match is not supported yet.");

      return methodNotAllowed(["POST"]);
    }

    rejectIfMatch(req);
    rejectIdempotencyKey(req);
    rejectIfNoneMatch(req, "If-None-Match is not supported yet.");

    const body = parseCreateCollectionBody(await readJsonBody(req));
    const collection = await service.createCollection(body.name, { fields: body.fields });

    return {
      status: 201,
      body: collection,
      headers: {
        location: `/v1/collections/${encodeURIComponent(collection.name)}`,
      },
    };
  }

  const collectionMatch = COLLECTION_PATH.exec(path);

  if (collectionMatch) {
    rejectUnexpectedQuery(url);
    rejectIfMatch(req);
    rejectIdempotencyKey(req);
    rejectIfNoneMatch(req, "If-None-Match is not supported yet.");

    if (method !== "DELETE") {
      return methodNotAllowed(["DELETE"]);
    }

    const segment = collectionMatch[1];

    if (segment === undefined) {
      throw new LamedError("not_found", `No route for ${method} ${path}.`);
    }

    await rejectUnexpectedBody(req, "Delete");
    await service.deleteCollection(decodePathSegment(segment));

    return {
      status: 204,
      body: undefined,
    };
  }

  const recordMatch = RECORD_PATH.exec(path);

  if (!recordMatch) {
    throw new LamedError("not_found", `No route for ${method} ${path}.`);
  }

  const collectionSegment = recordMatch[1];
  const idSegment = recordMatch[2];

  if (collectionSegment === undefined || idSegment === undefined) {
    throw new LamedError("not_found", `No route for ${method} ${path}.`);
  }

  const name = decodePathSegment(collectionSegment);
  const id = decodePathSegment(idSegment);

  if (method === "PUT") {
    rejectUnexpectedQuery(url);
    rejectCombinedMatchHeaders(req);

    const idempotencyKey = readIdempotencyKey(req);
    // createOnly is the bare If-None-Match: *. ifVersion is If-Match: "<version>".
    const createOnly = readCreateOnly(req);
    const ifVersion = readIfMatch(req);

    const outcome = await service.putRecord(name, id, await readJsonBody(req), {
      createOnly,
      ifVersion,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });

    return {
      status: outcome.created ? 201 : 200,
      body: outcome.record,
      headers: {
        etag: etagFor(outcome.record.version),
        location: recordLocation(name, outcome.record.id),
      },
    };
  }

  if (method === "GET") {
    rejectUnexpectedQuery(url);
    rejectIfMatch(req);
    rejectIdempotencyKey(req);
    rejectIfNoneMatch(req, "If-None-Match is not supported on this request.");

    await rejectUnexpectedBody(req, "GET");

    const record = await service.getRecord(name, id);

    return {
      status: 200,
      body: record,
      headers: {
        etag: etagFor(record.version),
      },
    };
  }

  if (method === "DELETE") {
    rejectUnexpectedQuery(url);
    rejectIfMatch(req);
    rejectIdempotencyKey(req);
    rejectIfNoneMatch(req, "If-None-Match is not supported yet.");

    await rejectUnexpectedBody(req, "Delete");

    await service.deleteRecord(name, id);

    return {
      status: 204,
      body: undefined,
    };
  }

  rejectIfMatch(req);
  rejectIdempotencyKey(req);
  rejectIfNoneMatch(req, "If-None-Match is not supported yet.");
  rejectUnexpectedQuery(url);

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

function requireListenOptions(options: ListenOptions): ListenOptions {
  if (options === undefined || options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new LamedError(
      "invalid_argument",
      "At least one API key is required. The server refuses to start without apiKeys.",
    );
  }

  return options;
}

function requireBearer(req: IncomingMessage, apiKeys: readonly string[]): void {
  const values = rawHeaderValues(req, "authorization");

  if (values.length !== 1) {
    throw unauthenticated();
  }

  const value = values[0];

  if (value === undefined || !bearerMatches(value, apiKeys)) {
    throw unauthenticated();
  }
}

function unauthenticated(): LamedError {
  return new LamedError("unauthenticated", "A valid API key is required.");
}

function bearerMatches(header: string, apiKeys: readonly string[]): boolean {
  const prefix = "Bearer ";

  if (!header.startsWith(prefix)) {
    return false;
  }

  const token = header.slice(prefix.length);

  if (token.length === 0 || /\s/.test(token)) {
    return false;
  }

  return apiKeyMatches(token, apiKeys);
}

function apiKeyMatches(token: string, apiKeys: readonly string[]): boolean {
  // Digests are equal length, so timingSafeEqual can compare them.
  // Every configured key is checked so the match position does not change the timing.
  const tokenHash = createHash("sha256").update(token).digest();
  let matched = false;

  for (const apiKey of apiKeys) {
    const keyHash = createHash("sha256").update(apiKey).digest();

    if (timingSafeEqual(tokenHash, keyHash)) {
      matched = true;
    }
  }

  return matched;
}

function parseCreateCollectionBody(body: unknown): { name: string; fields: unknown } {
  if (!isPlainObject(body)) {
    throw new LamedError("invalid_argument", "Request body must be a JSON object.");
  }

  for (const key of Object.keys(body)) {
    if (key !== "name" && key !== "fields") {
      throw new LamedError(
        "invalid_argument",
        `Unknown property "${previewKey(key)}". Expected "name" and "fields".`,
      );
    }
  }

  if (typeof body.name !== "string") {
    throw new LamedError("invalid_argument", 'Property "name" must be a string.');
  }

  return {
    name: body.name,
    fields: body.fields,
  };
}

function rejectIfMatch(req: IncomingMessage): void {
  if (req.headers["if-match"] !== undefined) {
    throw new LamedError(
      "invalid_argument",
      "If-Match is not supported yet. Conditional replaces are a follow-up.",
    );
  }
}

function rejectIdempotencyKey(req: IncomingMessage): void {
  if (req.headers["idempotency-key"] !== undefined) {
    throw new LamedError("invalid_argument", "Idempotency-Key is not supported yet.");
  }
}

function rejectCombinedMatchHeaders(req: IncomingMessage): void {
  if (req.headers["if-match"] !== undefined && req.headers["if-none-match"] !== undefined) {
    throw new LamedError("invalid_argument", "If-Match and If-None-Match cannot be used together.");
  }
}

function rejectIfNoneMatch(req: IncomingMessage, message: string): void {
  if (req.headers["if-none-match"] !== undefined) {
    throw new LamedError("invalid_argument", message);
  }
}

function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const values = rawHeaderValues(req, "idempotency-key");

  if (values.length === 0) {
    return undefined;
  }

  if (values.length > 1) {
    throw new LamedError("invalid_argument", "Idempotency-Key must be a single header value.");
  }

  const value = values[0];

  if (value === undefined) {
    return undefined;
  }

  return parseIdempotencyKey(value);
}

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const headerName = req.rawHeaders[index];
    const headerValue = req.rawHeaders[index + 1];

    if (headerName !== undefined && headerValue !== undefined && headerName.toLowerCase() === name) {
      values.push(headerValue);
    }
  }

  return values;
}

function rejectUnexpectedQuery(url: URL): void {
  const name = url.searchParams.keys().next();

  if (name.done) {
    return;
  }

  throw new LamedError(
    "invalid_argument",
    `Unknown query parameter "${previewKey(name.value)}".`,
  );
}

/** A body was sent to a route that never reads one. The socket is closed after the 400. */
class UnreadBodyError extends LamedError {
  constructor(method: string) {
    super("invalid_argument", `${method} does not accept a request body.`);
    this.name = "UnreadBodyError";
  }
}

/** Reject a body without reading it, so an unauthenticated caller cannot make the server buffer one. */
function rejectUnreadBody(req: IncomingMessage): void {
  const length = req.headers["content-length"];
  const hasLength = length !== undefined && !/^0+$/.test(length.trim());

  if (hasLength || req.headers["transfer-encoding"] !== undefined) {
    throw new UnreadBodyError("GET");
  }
}

async function rejectUnexpectedBody(req: IncomingMessage, method: string): Promise<void> {
  const body = await readLimitedBody(req);

  if (body.length === 0) {
    return;
  }

  throw new LamedError("invalid_argument", `${method} does not accept a request body.`);
}

function readIfMatch(req: IncomingMessage): number | undefined {
  const header = req.headers["if-match"];

  if (header === undefined) {
    return undefined;
  }

  const value = (Array.isArray(header) ? header.join(", ") : header).trim();

  if (value.includes(",")) {
    throw new LamedError("invalid_argument", "If-Match must be a single quoted version.");
  }

  const match = /^"(0|[1-9][0-9]*)"$/.exec(value);

  if (!match || match[1] === undefined) {
    throw new LamedError("invalid_argument", 'If-Match must be a quoted version, such as "1".');
  }

  const version = Number(match[1]);

  if (!Number.isSafeInteger(version)) {
    throw new LamedError("invalid_argument", 'If-Match must be a quoted version, such as "1".');
  }

  return version;
}

function readCreateOnly(req: IncomingMessage): boolean {
  const header = req.headers["if-none-match"];

  if (header === undefined) {
    return false;
  }

  const value = (Array.isArray(header) ? header.join(", ") : header).trim();

  // Only the bare wildcard is createOnly. A quoted "*" is an entity tag.
  if (value === "*") {
    return true;
  }

  throw new LamedError("invalid_argument", 'If-None-Match only supports "*" in this version.');
}

function methodNotAllowed(allow: readonly string[]): HttpResult {
  const error = new LamedError("method_not_allowed", "Method not allowed.");

  return {
    status: error.status,
    body: error.toJSON(),
    headers: {
      allow: allow.join(", "),
    },
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  onFlushed?: () => void,
): void {
  if (res.headersSent || res.writableEnded) {
    onFlushed?.();

    return;
  }

  if (status === 204) {
    res.writeHead(status, {
      "cache-control": "no-store",
      ...headers,
    });
    res.end(() => {
      onFlushed?.();
    });

    return;
  }

  const payload = JSON.stringify(body);

  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload, () => {
    onFlushed?.();
  });
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new LamedError("invalid_argument", "Path segment is not valid percent-encoding.");
  }
}

function recordLocation(name: string, id: string): string {
  return `/v1/collections/${encodeURIComponent(name)}/records/${encodeURIComponent(id)}`;
}

function etagFor(version: number): string {
  return `"${version}"`;
}

function formatHost(host: string): string {
  if (host.includes(":")) {
    return `[${host}]`;
  }

  return host;
}

function previewKey(value: string): string {
  const flat = value.replace(/[\u0000-\u001F\u007F]/g, " ");

  if (flat.length <= 80) {
    return flat;
  }

  return `${flat.slice(0, 77)}...`;
}
