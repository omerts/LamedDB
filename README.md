# LamedDB

LamedDB is a cloud-native database that adapts how it stores, serves, and streams data as usage changes. Applications use one API to write and query records, publish events, and subscribe to changes. A collection can change physical layout without changing application code.

The pilot is a TypeScript SDK and HTTP API for single-region workflows such as orders, tickets, and activity.

This slice stores data in memory behind a `Store` interface. A durable engine can replace that adapter later. There is no authentication yet. The server binds to `127.0.0.1` unless `HOST` is set.

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
npm run dev
```

The server listens on `http://127.0.0.1:8080`. Override the bind address with `HOST` and `PORT`.

`npm run build` writes `dist/`. `npm start` runs the compiled server.

## API

Declared field types are `string`, `integer` (a JSON safe integer), and `timestamp` (a UTC instant with millisecond precision, such as `2026-11-19T08:15:00.000Z`). Null is a stored value. Fields that are not declared are stored as JSON. `put` replaces the whole document. The first write of an id is version `1`, and each successful replace adds 1. `delete` removes the record and keeps its last version. A later put of that id continues at last + 1, so an `ETag` from before the delete does not match the recreated record.

`createOnly` is sent as `If-None-Match: *`. If the record already exists, the response is `412` and the stored record is unchanged.

`ifVersion` is sent as `If-Match: "<version>"`. `GET` and `PUT` return that version in `ETag`. A matching `If-Match` replaces the record and the new version is one higher. A stale `If-Match`, or `If-Match` when the id is missing, is `412` and writes nothing. `*`, a list, and any other `If-Match` value are `400`. `If-Match` together with `If-None-Match` is `400`.

```ts
import { LamedDB } from "lameddb";

const db = new LamedDB({ baseUrl: "http://127.0.0.1:8080" });

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
  { createOnly: true },
);

const order = await orders.get("ord_123");
await orders.put(
  "ord_123",
  { status: "refunded", totalCents: 0, createdAt: "2026-11-19T08:15:00.000Z" },
  { ifVersion: order.version },
);
await orders.delete("ord_123");
```

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/collections \
  -H 'content-type: application/json' \
  -d '{"name":"orders","fields":{"status":"string","createdAt":"timestamp","totalCents":"integer"}}'

curl -sS -X PUT http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'content-type: application/json' \
  -H 'if-none-match: *' \
  -d '{"status":"paid","totalCents":12900,"createdAt":"2026-11-19T08:15:00.000Z"}'

curl -sS -D - http://127.0.0.1:8080/v1/collections/orders/records/ord_123

curl -sS -D - -X PUT http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'content-type: application/json' \
  -H 'if-match: "1"' \
  -d '{"status":"refunded","totalCents":0,"createdAt":"2026-11-19T08:15:00.000Z"}'

curl -sS -D - -o /dev/null -X DELETE http://127.0.0.1:8080/v1/collections/orders/records/ord_123
```

| SDK | HTTP | Result |
| --- | --- | --- |
| `admin.createCollection(name, spec?)` | `POST /v1/collections` | `201` and `{ name, fields }` |
| `collection.put(id, data, options?)` | `PUT /v1/collections/{name}/records/{id}` | `201` on create, `200` on replace, body `{ id, version, data }`, `ETag: "<version>"`. `ifVersion` is `If-Match`. A miss is `412` |
| `collection.get(id)` | `GET /v1/collections/{name}/records/{id}` | `200` and the record with `ETag`, or `404` |
| `collection.delete(id)` | `DELETE /v1/collections/{name}/records/{id}` | `204` with no body, or `404` |

Errors are JSON: `{ "error": { "code", "message", "details?" } }`. Codes include `invalid_argument` (400), `not_found` (404), `already_exists` (409), and `precondition_failed` (412).

## Not in this slice

Idempotency keys, event emit, tenancy and credentials, queries, and a durable store are follow-ups. `If-Match` on create, get, and delete is rejected. `Idempotency-Key` on create, put, get, and delete is rejected. `If-None-Match` on get and delete is rejected. A query parameter is rejected on every method. A request body on get or delete is rejected. Those inputs are not silently ignored.
