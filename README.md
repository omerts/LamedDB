# LamedDB

LamedDB is a cloud-native database that adapts how it stores, serves, and streams data as usage changes. Applications use one API to write and query records, publish events, and subscribe to changes. A collection can change physical layout without changing application code.

[Product plan](docs/proposal.md)

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
| `admin.createCollection(name, spec?)` | `POST /v1/collections` | `201` and `{ name, fields, aliases? }`. `spec` is `{ fields?, aliases? }` |
| `admin.deleteCollection(name)` | `DELETE /v1/collections/{name}` | `204` with no body, or `404`. Drops the collection's records and idempotency keys |
| `collection.put(id, data, options?)` | `PUT /v1/collections/{name}/records/{id}` | `201` on create, `200` on replace, body `{ id, version, data }`, `ETag: "<version>"`. `ifVersion` is `If-Match`. A miss is `412` |
| `collection.get(id)` | `GET /v1/collections/{name}/records/{id}` | `200` and the record with `ETag`, or `404` |
| `collection.delete(id)` | `DELETE /v1/collections/{name}/records/{id}` | `204` with no body, or `404` |
| `collection.list({ limit?, cursor?, sort?, filter? })` | `GET /v1/collections/{name}/records` | `200` and `{ records, nextCursor }`, or `404`. See [List records](#list-records) |

Errors are JSON: `{ "error": { "code", "message", "details?" } }`. Codes include `invalid_argument` (400), `unauthenticated` (401), `not_found` (404), `already_exists` (409), `idempotency_conflict` (409), and `precondition_failed` (412).

## List records

```bash
curl -sS -G http://127.0.0.1:8080/v1/collections/orders/records \
  -H 'authorization: Bearer dev-key' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'sort=-amount' \
  --data-urlencode 'filter[status]=paid' \
  --data-urlencode 'filter[amount][gte]=1000' \
  --data-urlencode 'filter[createdAt][lt]=2026-12-01T00:00:00.000Z'
```

```ts
const options = {
  limit: 20,
  sort: "-amount",
  filter: { status: "paid", amount: { gte: 1000 }, createdAt: { lt: "2026-12-01T00:00:00.000Z" } },
};
const page = await db.collection("orders").list(options);

if (page.nextCursor !== null) {
  // The next page needs the same filter and sort, plus the cursor.
  const next = await db.collection("orders").list({ ...options, cursor: page.nextCursor });
}
```

The response is `{ "records": [{ "id", "version", "data" }], "nextCursor": string | null }`. `nextCursor` is `null` on the last page. An empty result is `{ "records": [], "nextCursor": null }`.

**Paging.** `limit` is a whole number from 1 to 100 and defaults to 50. A value above 100 is `400`, not clamped. The order is ascending `id` (plain string order), or the `sort` order. `cursor` is opaque: pass back the `nextCursor` of the previous page, with the same filters and sort. A cursor from another collection (or from a collection that was deleted and created again), or used with different filters or sort, is `400`. Each page re-reads the collection, so nothing is held between pages. A record that matches for the whole walk is returned exactly once, however other records are added, replaced, or deleted. A record added mid-walk is returned only if it sorts after the current position. When sorting by a field other than `id`, a record whose sort value changes mid-walk may be returned twice or skipped.

**Filters.** `filter[field]=value` is equality. `filter[field][op]=value` uses an operator. Several clauses are ANDed, up to 10 per request, and the same field and operator cannot repeat.

| Operator | Meaning | Notes |
| --- | --- | --- |
| `eq` | equal | the default |
| `ne` | not equal | also matches null or missing values, unless the value is `null` |
| `gt`, `gte`, `lt`, `lte` | range | integers by number, timestamps by time, strings by code unit. Never match null or missing, and cannot compare with `null` |
| `in` | one of | comma-separated, 1 to 20 values, so a value cannot hold a comma. `in=` is one empty string. The SDK takes an array |
| `prefix` | starts with | string fields only, not empty |

Filterable fields are the declared fields, their aliases, and `id`. Values are read by the declared type: strings as is, integers as whole numbers, timestamps as UTC with milliseconds. The bare value `null` means "null or missing" (so the string `"null"` cannot be matched). An unknown field, an unknown operator, an operator that does not fit the type, a bad value, and a malformed key are `400`, and the message names the field or operator and lists the valid ones.

**Aliases.** A collection can declare `aliases` when it is created, such as `{ fields: { totalCents: "integer" }, aliases: { amount: "totalCents" } }`. Callers can use `amount` in `filter` and `sort`. An alias cannot equal a declared field or `id`, and must point at a declared field. A bad alias is `400` and the collection is not created.

**Sort.** `sort=field` ascending, `sort=-field` descending, one field. Sortable: `id`, and integer or timestamp fields (or their aliases). Missing and null values come first ascending and last descending. Ties are broken by ascending `id`.

**Errors.** `401` without a key (checked first), `404` for a missing collection, `405` with `Allow: GET` for other methods (after the key check, whatever else the request carries), `400` for a bad `limit`, `cursor`, `sort`, or filter, or for a body, `If-Match`, `If-None-Match`, or `Idempotency-Key`. This is the only route that accepts query parameters, and only `limit`, `cursor`, `sort`, and `filter[...]`.

## MCP tool

`lameddb-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server with one read-only tool, `query_records`. It wraps `GET /v1/collections/{name}/records`, so an agent can page through records with filters and sort.

```bash
npm run build
LAMEDDB_URL=http://127.0.0.1:8080 LAMEDDB_API_KEY=dev-key npm run start:mcp   # or: npm run mcp, or the lameddb-mcp bin
```

| Variable | Meaning |
| --- | --- |
| `LAMEDDB_API_KEY` | Required. Sent as the bearer key. Never printed or put in an error. |
| `LAMEDDB_URL` | Server URL. Default `http://127.0.0.1:8080`. |
| `LAMEDDB_TIMEOUT_MS` | Per-request timeout. Default `10000`. |

MCP client config:

```json
{ "mcpServers": { "lameddb": { "command": "node", "args": ["dist/mcp/main.js"], "env": { "LAMEDDB_URL": "http://127.0.0.1:8080", "LAMEDDB_API_KEY": "dev-key" } } } }
```

`query_records` takes `collection` (required), `limit` (1 to 100), `cursor`, `sort` (`field` or `-field`) and `filter` (a field or alias mapped to a string, number or `null`, or to operators `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `prefix`). Example: `{"collection":"orders","filter":{"amount":{"gte":1000}},"sort":"-amount","limit":20}`. It returns `{ "records": [...], "nextCursor": string | null }` as JSON text. Unknown arguments, unknown operators, a bad collection name, `limit` outside 1 to 100, and non-scalar filter values are rejected before any request. Failures come back as tool errors (`isError`), not crashes: invalid input, a server that is down, `401` (bad key), `404` (unknown collection), a server-side `400`, and timeouts.

## Not in this slice

Idempotency for collection creation, event emit, per-key permissions, key rotation, tenancy, indexes and richer queries (`OR`/`NOT`, sorting by strings or several fields, counts), and a durable store are follow-ups. Listing scans the collection on every page. `If-Match` on create, get, and delete is rejected. `Idempotency-Key` on create, get, and delete is rejected. `If-None-Match` on get and delete is rejected. A query parameter is rejected on every method, except `limit`, `cursor`, `sort`, and `filter[...]` on `GET /v1/collections/{name}/records`. A request body on get or delete is rejected. Those inputs are not silently ignored.
