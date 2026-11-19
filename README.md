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

Declared field types are `string`, `integer` (a JSON safe integer), and `timestamp` (a UTC instant with millisecond precision, such as `2026-11-19T08:15:00.000Z`). Null is a stored value. Fields that are not declared are stored as JSON. `put` replaces the whole document. The first write of an id is version `1`, and each successful replace adds 1.

`createOnly` is sent as `If-None-Match: *`. If the record already exists, the response is `412` and the stored record is unchanged.

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
```

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/collections \
  -H 'content-type: application/json' \
  -d '{"name":"orders","fields":{"status":"string","createdAt":"timestamp","totalCents":"integer"}}'

curl -sS -X PUT http://127.0.0.1:8080/v1/collections/orders/records/ord_123 \
  -H 'content-type: application/json' \
  -H 'if-none-match: *' \
  -d '{"status":"paid","totalCents":12900,"createdAt":"2026-11-19T08:15:00.000Z"}'

curl -sS http://127.0.0.1:8080/v1/collections/orders/records/ord_123
```

| SDK | HTTP | Result |
| --- | --- | --- |
| `admin.createCollection(name, spec?)` | `POST /v1/collections` | `201` and `{ name, fields }` |
| `collection.put(id, data, options?)` | `PUT /v1/collections/{name}/records/{id}` | `201` on create, `200` on replace, body `{ id, version, data }` |
| `collection.get(id)` | `GET /v1/collections/{name}/records/{id}` | `200` and the record, or `404` |

Errors are JSON: `{ "error": { "code", "message", "details?" } }`. Codes include `invalid_argument` (400), `not_found` (404), `already_exists` (409), and `precondition_failed` (412).

## Not in this slice

Delete, `If-Match` / `ifVersion`, idempotency keys, event emit, tenancy and credentials, queries, and a durable store are follow-ups. Sending `If-Match` or `Idempotency-Key` is rejected so those preconditions are not silently ignored.
