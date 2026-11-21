# LamedDB

LamedDB is a cloud-native database that adapts how it stores, serves, and streams data as usage changes. Applications use one API to write and query records, publish events, and subscribe to changes. A collection can change physical layout without changing application code.

The pilot is a TypeScript SDK and HTTP API for single-region workflows such as orders, tickets, and activity.

This slice stores data in memory behind a `Store` interface. A durable engine can replace that adapter later. Every request needs an API key. The server binds to `127.0.0.1` unless `HOST` is set, and it refuses to start when `LAMEDDB_API_KEYS` is missing.

## Requirements

- Node.js 20 or newer

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Run

```bash
LAMEDDB_API_KEYS=dev-key npm run dev
```

The server listens on `http://127.0.0.1:8080`. Override the bind address with `HOST` and `PORT`.

Set `LAMEDDB_API_KEYS` to one or more comma-separated API keys before starting the server. Surrounding spaces are ignored. `LAMEDDB_API_KEYS=key-one,key-two` accepts either key. The server refuses to start without the variable, including when it binds to localhost. Send `Authorization: Bearer <key>` on every request. A missing or wrong key is `401` `unauthenticated` with `WWW-Authenticate: Bearer`. The message is the same in both cases and does not include the key.

`GET /health` is the one route that needs no key. It returns `200` with `{"status":"ok"}` and nothing else, so load balancers and uptime checks can call it. `/health` rejects `If-Match`, `If-None-Match`, `Idempotency-Key`, a query parameter and a request body with `400`. Any other method on `/health` needs a key and returns `405`.

`npm run build` writes `dist/`. `npm start` runs the compiled server and requires the same `LAMEDDB_API_KEYS`.

## API

Declared field types are `string`, `integer` (a JSON safe integer), and `timestamp` (a UTC instant with millisecond precision, such as `2026-11-19T08:15:00.000Z`). Null is a stored value. Fields that are not declared are stored as JSON. `put` replaces the whole document. The first write of an id is version `1`, and each successful replace adds 1. `delete` removes the record and keeps its last version. A later put of that id continues at last + 1, so an `ETag` from before the delete does not match the recreated record.

`createOnly` is sent as `If-None-Match: *`. If the record already exists, the response is `412` and the stored record is unchanged.

`ifVersion` is sent as `If-Match: "<version>"`. `GET` and `PUT` return that version in `ETag`. A matching `If-Match` replaces the record and the new version is one higher. A stale `If-Match`, or `If-Match` when the id is missing, is `412` and writes nothing. `*`, a list, and any other `If-Match` value are `400`. `If-Match` together with `If-None-Match` is `400`.

`idempotencyKey` is sent as `Idempotency-Key` (1–255 printable ASCII characters, with no leading or trailing whitespace). The same put — same collection, id, document, and options, including `ifVersion` — returns the original status and body and does not write again. A different put that reuses the key returns `409` `idempotency_conflict` and does not write. A failed put (`4xx`) is not remembered, so a corrected retry can use the same key. Keys are scoped to one collection. A later record delete does not clear the key: the retry still returns the original put and does not recreate the record. `If-Match` and `Idempotency-Key` can be sent on the same put. Collection create, collection delete, record get, and record delete reject the idempotency header.

A stored key expires after 24 hours. Set `IDEMPOTENCY_TTL_MS` to a positive number of milliseconds to change that. Each collection keeps at most 10000 keys. Set `IDEMPOTENCY_MAX_KEYS` to change the cap. When a successful put would go past the cap, the oldest stored key is dropped. Replaying a key does not make it newer, and it does not extend the TTL. An expired or dropped key is a new request: it is processed again, including when the body differs. A replay before expiry still returns the original response. Deleting the collection drops its keys, its records, and its version counters. Recreating the collection starts versions at 1, and a key from the deleted collection is new.

```ts
import { LamedDB } from "lameddb";

const baseUrl = "http://127.0.0.1:8080";
const apiKey = "dev-key";
const db = new LamedDB({ baseUrl, apiKey });

await db.admin.createCollection("orders", {
  fields: { status: "string", createdAt: "timestamp", totalCents: "integer" },
});

const orders = db.collection("orders");

await orders.put(
  "ord_123",
  {
    status: "paid",
    totalCents: 12900,
    createdAt: "2026-11-19T08:15:00.000Z",
  },
  { createOnly: true, idempotencyKey: "ord_123-paid" },
);

const order = await orders.get("ord_123");
await orders.put(
  "ord_123",
  { status: "refunded", totalCents: 0, createdAt: "2026-11-19T08:15:00.000Z" },
  { ifVersion: order.version },
);
await orders.delete("ord_123");
await db.admin.deleteCollection("orders");
```

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/collections \
  -H 'authorization: Bearer dev-key' \
  -H 'content-type: application/json' \
  -d '{"name":"orders","fields":{"status":"string","createdAt":"timestamp","totalCents":"integer"}}'

curl -sS -X PUT http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'authorization: Bearer dev-key' \
  -H 'content-type: application/json' \
  -H 'if-none-match: *' \
  -H 'idempotency-key: ord_123-paid' \
  -d '{"status":"paid","totalCents":12900,"createdAt":"2026-11-19T08:15:00.000Z"}'

curl -sS -D - http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'authorization: Bearer dev-key'

curl -sS -D - -X PUT http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'authorization: Bearer dev-key' \
  -H 'content-type: application/json' \
  -H 'if-match: "1"' \
  -d '{"status":"refunded","totalCents":0,"createdAt":"2026-11-19T08:15:00.000Z"}'

curl -sS -D - -o /dev/null -X DELETE http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'authorization: Bearer dev-key'

curl -sS -D - -o /dev/null -X DELETE http://127.0.0.1:8080/v1/collections/orders \
  -H 'authorization: Bearer dev-key'
```

| SDK | HTTP | Result |
| --- | --- | --- |
| `admin.createCollection(name, spec?)` | `POST /v1/collections` | `201` and `{ name, fields }` |
| `admin.deleteCollection(name)` | `DELETE /v1/collections/{name}` | `204` with no body, or `404`. Drops the collection's records and idempotency keys |
| `collection.put(id, data, options?)` | `PUT /v1/collections/{name}/records/{id}` | `201` on create, `200` on replace, body `{ id, version, data }`, `ETag: "<version>"`. `ifVersion` is `If-Match`. A miss is `412` |
| `collection.get(id)` | `GET /v1/collections/{name}/records/{id}` | `200` and the record with `ETag`, or `404` |
| `collection.delete(id)` | `DELETE /v1/collections/{name}/records/{id}` | `204` with no body, or `404` |

Errors are JSON: `{ "error": { "code", "message", "details?" } }`. Codes include `invalid_argument` (400), `unauthenticated` (401), `not_found` (404), `already_exists` (409), `idempotency_conflict` (409), and `precondition_failed` (412).

## Not in this slice

Idempotency for collection creation, event emit, per-key permissions, key rotation, tenancy, queries, and a durable store are follow-ups. `If-Match` on create, get, and delete is rejected. `Idempotency-Key` on create, get, and delete is rejected. `If-None-Match` on get and delete is rejected. A query parameter is rejected on every method. A request body on get or delete is rejected. Those inputs are not silently ignored.
