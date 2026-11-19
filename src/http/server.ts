import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { CollectionService } from "../collections/service.js";
import { LamedError } from "../errors.js";
import { MemoryStore } from "../storage/memory-store.js";
import type { Store } from "../storage/store.js";
import { isPlainObject } from "../validate.js";
import { OversizedBodyError, readJsonBody, readLimitedBody } from "./body.js";

const RECORD_PATH = /^\/v1\/collections\/([^/]+)\/records\/([^/]+)$/;

export interface ListenOptions {
  port?: number;
  host?: string;
  store?: Store;
  service?: CollectionService;
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

export async function listen(options: ListenOptions = {}): Promise<RunningServer> {
  const service = options.service ?? new CollectionService(options.store ?? new MemoryStore());
  const server = createServer((req, res) => {
    void handleRequest(req, res, service);
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

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
): Promise<void> {
  try {
    const result = await route(req, service);
    writeJson(res, result.status, result.body, result.headers);
  } catch (error) {
    if (error instanceof LamedError) {
      const headers: Record<string, string> = {};

      if (error instanceof OversizedBodyError) {
        headers.connection = "close";
      }

      writeJson(res, error.status, error.toJSON(), headers, () => {
        if (error instanceof OversizedBodyError && !req.destroyed) {
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

async function route(req: IncomingMessage, service: CollectionService): Promise<HttpResult> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/v1/collections") {
    if (method !== "POST") {
      return methodNotAllowed(["POST"]);
    }

    rejectUnsupportedPreconditions(req);

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
    rejectUnsupportedPreconditions(req);

    // createOnly is the bare If-None-Match: *. A failed precondition is 412.
    const createOnly = readCreateOnly(req);
    const outcome = await service.putRecord(name, id, await readJsonBody(req), { createOnly });

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
    rejectUnsupportedPreconditions(req);
    rejectDeleteIfNoneMatch(req);
    rejectDeleteQuery(url);

    await rejectDeleteBody(req);

    await service.deleteRecord(name, id);

    return {
      status: 204,
      body: undefined,
    };
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
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

function rejectUnsupportedPreconditions(req: IncomingMessage): void {
  if (req.headers["if-match"] !== undefined) {
    throw new LamedError(
      "invalid_argument",
      "If-Match is not supported yet. Conditional replaces are a follow-up.",
    );
  }

  if (req.headers["idempotency-key"] !== undefined) {
    throw new LamedError("invalid_argument", "Idempotency-Key is not supported yet.");
  }
}

function rejectDeleteIfNoneMatch(req: IncomingMessage): void {
  if (req.headers["if-none-match"] !== undefined) {
    throw new LamedError("invalid_argument", "If-None-Match is not supported yet.");
  }
}

function rejectDeleteQuery(url: URL): void {
  const name = url.searchParams.keys().next();

  if (name.done) {
    return;
  }

  throw new LamedError(
    "invalid_argument",
    `Unknown query parameter "${previewKey(name.value)}". Delete does not support query parameters.`,
  );
}

async function rejectDeleteBody(req: IncomingMessage): Promise<void> {
  const body = await readLimitedBody(req);

  if (body.length === 0) {
    return;
  }

  throw new LamedError("invalid_argument", "Delete does not accept a request body.");
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
