# AGENTS.md

Instructions for coding agents working in this repo. The rules in [Project rules](#project-rules) are the review standards.

## Project

LamedDB is an adaptive cloud-native database: one API to write and query records, publish events, and subscribe to changes, plus a hosted MCP server. It picks layout, partitioning, tier, and indexes from the workload so application code never changes. Pilot users are B2B SaaS teams building bounded workflows such as orders, tickets, and activity feeds. What exists today is a `node:http` server (`src/cli.ts`, `src/http/server.ts`) in front of `CollectionService` (`src/collections/service.ts`) and the `Store` interface (`src/storage/store.ts`, with in-memory `MemoryStore` in `src/storage/memory-store.ts` as its only implementation), plus a TypeScript SDK (`src/sdk/client.ts`, exported from `src/index.ts`) that creates a collection and puts, gets, and deletes records whose declared fields are `string`, `integer`, and `timestamp` (`src/types.ts`, checked in `src/validate.ts`). A put can require the current version with `If-Match` / `ifVersion`, and a record put accepts `Idempotency-Key`. A stored key expires after a TTL (default 24 hours, `IDEMPOTENCY_TTL_MS`) and each collection keeps at most `LIMITS.maxIdempotencyKeysPerCollection` keys (`IDEMPOTENCY_MAX_KEYS`, default 10000). The oldest key is dropped when a successful put would pass the cap. An expired or dropped key is processed again. Deleting a collection drops its keys. Queries, event publish, change subscriptions, the hosted MCP server, authentication, idempotency for collection creation, and any durable store are not implemented yet; the live routes are `POST /v1/collections`, `DELETE /v1/collections/{name}`, and `PUT`/`GET`/`DELETE /v1/collections/{name}/records/{id}` (`README.md`).

## Setup and verification

Node.js 20 or newer (`engines` in `package.json`).

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

- `npm test` runs `vitest run` (`vitest.config.ts`, included files `test/**/*.test.ts`).
- `npm run typecheck` runs `tsc -p tsconfig.test.json --noEmit` and covers `src/**/*.ts` and `test/**/*.ts`.
- `npm run build` runs `tsc -p tsconfig.json` and writes `dist/` from `src/**/*.ts`.
- `npm run dev` runs `tsx src/cli.ts` and listens on `http://127.0.0.1:8080`. `HOST` and `PORT` override the bind address (`src/cli.ts`; default host `127.0.0.1`, default port `8080`).
- `npm start` runs `node dist/cli.js` after `npm run build`, with the same `HOST` and `PORT` defaults.

## Project rules

### The No Silent Ignores Rule

A header, query parameter, body field, or SDK option that asks for behavior this version does not implement is rejected with `400` and `LamedError` code `invalid_argument`, and storage is left unchanged. Copy `rejectIfMatch`, `rejectIdempotencyKey`, and the unknown-key loop in `parseCreateCollectionBody` (`src/http/server.ts`): `If-Match` and `Idempotency-Key` fail on `POST /v1/collections`, and a create body may contain only `name` and `fields`. `If-Match` on `PUT /v1/collections/{name}/records/{id}` is one quoted version (`PutOptions.ifVersion`); a wildcard, a list, or any other shape is `invalid_argument`, and `If-Match` together with `If-None-Match` is `invalid_argument`. `Idempotency-Key` is accepted on that PUT (`PutOptions.idempotencyKey`, sent by `CollectionClient.put`) and fails on every other method, including `POST /v1/collections`, `DELETE /v1/collections/{name}`, `GET`, and `DELETE`. The two headers may be sent together. The idempotency fingerprint includes `ifVersion`, and a replay returns the original response. `If-None-Match` accepts only a bare `*` on PUT, which is `PutOptions.createOnly` (`src/types.ts`). `If-Match`, `If-None-Match`, and `Idempotency-Key` fail on `GET` and on `DELETE`. `DELETE /v1/collections/{name}` removes the collection, its records, its version counters, and its idempotency keys. `If-Match`, `If-None-Match`, `Idempotency-Key`, a query parameter, and a body on that route are `invalid_argument`, and the collection is left in place. The same rejection applies to headers, query parameters, and request bodies on every method, including methods that take no body such as `GET` and `DELETE`. An unexpected query parameter or request body is `400` `invalid_argument` before storage changes. `CollectionClient.delete` takes an id and no options. Supported SDK options are `LamedDBOptions.baseUrl`, `LamedDBOptions.fetch`, `CollectionSpec.fields`, `PutOptions.createOnly`, `PutOptions.ifVersion`, and `PutOptions.idempotencyKey`. Unknown put options are rejected, including non-enumerable and symbol keys. The rule covers API semantics: preconditions, idempotency, filters, extra fields, and extra options. Transport headers the server already honors (`content-type`, `host`, `content-length`) stay as they are.

Applies to: `src/http/server.ts`, `src/http/body.ts`, `src/sdk/client.ts`, `src/types.ts`.

Why: a client that believes a guarantee (for example idempotency or a precondition) holds when it does not is worse off than one that gets an error. Origin: Day 1 Qodo review found `POST /v1/collections` silently accepted `Idempotency-Key` and `If-Match`. On PR #6, Qodo caught `DELETE` silently ignoring `?ifVersion` and a request body.

### Edge cases ship with the feature

Every new capability or fix includes tests for its failure paths — invalid input, missing resources, precondition failures, and limits — in the same change as the happy path. Cover the `400` / `404` / `409` / `412` responses the behavior can produce, and assert the stored data is unchanged when the call fails. Limits live in `LIMITS` in `src/validate.ts` (body size is 1 MiB via `src/http/body.ts`). Idempotency retention defaults are `LIMITS.idempotencyTtlMs` (24 hours) and `LIMITS.maxIdempotencyKeysPerCollection`.

Applies to: `test/**/*.test.ts` (today `test/collections.test.ts`, `test/idempotency.test.ts`, and `test/idempotency-expiry.test.ts`) for every change under `src/`.

Why: on Day 1 Qodo found 4 bugs, none covered by a test.

### Don't trust the types

Public exports and HTTP handlers validate input at runtime before using it. In `src/validate.ts`, `parseCollectionName` and `parseRecordId` take `unknown` and reject non-strings with `typeof`; `parseFieldDeclarations` and `validateDocument` require a plain object via `isPlainObject`. `parseCreateCollectionBody` in `src/http/server.ts` checks `body.name` with `typeof`. `readJsonBody` in `src/http/body.ts` checks `Content-Type` and `JSON.parse`. The `LamedDB` constructor in `src/sdk/client.ts` checks `baseUrl` with `typeof`. `CollectionService.createCollection` passes `spec.fields` as `unknown`, and `putRecord` passes `data` as `unknown`, into those parsers (`src/collections/service.ts`). `deleteRecord` passes the collection name and record id through `parseCollectionName` and `parseRecordId`. `parseIdempotencyKey` and `parsePutOptions` take `unknown` and reject a non-string key, a key outside 1-255 printable ASCII characters, a key with leading or trailing whitespace, a non-boolean `createOnly`, an `ifVersion` that is not a non-negative safe integer, and unknown put options, including non-enumerable and symbol keys. `parseMemoryStoreOptions` takes `unknown` and rejects a non-object, a `now` that is not a function, an `idempotencyTtlMs` or `maxIdempotencyKeys` that is not a positive safe integer, and unknown store options, including non-enumerable and symbol keys. `deleteCollection` passes the name through `parseCollectionName`, including the SDK before it builds the request path. Values that enter through `src/index.ts`, the SDK, or HTTP get these checks even when a TypeScript signature already names a type.

Applies to: `src/index.ts`, `src/http/server.ts`, `src/http/body.ts`, `src/collections/service.ts`, `src/validate.ts`, `src/sdk/client.ts`.

Why: JavaScript callers and raw HTTP clients bypass TypeScript.

### Every error gets a response

Errors return the `LamedError.toJSON()` envelope from `src/errors.ts` and the status on `LamedError.status`. The shape is `{ "error": { "code": ErrorCode, "message": string, "details"?: object } }`. `details` is omitted when absent. Codes and statuses: `invalid_argument` 400, `not_found` 404, `already_exists` 409, `idempotency_conflict` 409, `precondition_failed` 412, `method_not_allowed` 405, `internal` 500. `handleRequest` in `src/http/server.ts` writes that JSON for a `LamedError` and for any other thrown value (`internal` / 500) through `writeJson` before it returns. An oversized body (`OversizedBodyError` in `src/http/body.ts`) pauses the request, `writeJson` sends the 400, and the socket is destroyed only in the `writeJson` flush callback.

Applies to: `src/http/server.ts` (`handleRequest`, `writeJson`), `src/http/body.ts`, `src/errors.ts`.

Why: the client has to receive the status and the error envelope. Destroying the socket before `writeJson` finishes drops that response.

### All storage goes through `Store`

Service and HTTP code depend on the `Store` interface in `src/storage/store.ts` (`createCollection`, `getCollection`, `deleteCollection`, `putRecord`, `getRecord`, `deleteRecord`). `CollectionService` takes a `Store` in its constructor. `route` and `handleRequest` call `CollectionService`. `putRecord` applies the write, the `createOnly` check, the `ifVersion` check, the idempotency expiry check, and any key record in that one call. The service does not read the version, or decide that a key is live, and then write. The put carries the collection `revision` from that read, and the store rejects the write when the name now refers to a different collection. `deleteCollection` removes only that collection's records, version counters, and keys. A failed write is not stored and does not evict a live key. The key is stored per collection with the request fingerprint, the original result, and the time it was stored. A live key is replayed. An expired or evicted key is processed again. When a successful put would pass the collection cap, the oldest stored key is dropped. Replaying a key does not refresh its age or its TTL. `deleteRecord` removes the record and keeps its last version, so a later put of that id continues at last + 1, and it does not drop idempotency keys. `deleteCollection` removes the collection, its records, its version counters, and its keys. A new layout or tier is a new class under `src/storage/` that implements `Store`, passed in as `listen({ store })` or `new CollectionService(store)`. The one `MemoryStore` construction in HTTP code is the default inside `listen` (`src/http/server.ts`), used when the caller passes neither `store` nor `service`. `src/cli.ts` builds that store from `IDEMPOTENCY_TTL_MS` and `IDEMPOTENCY_MAX_KEYS` when it starts the process.

Applies to: `src/collections/service.ts`, `src/http/server.ts`, `src/storage/store.ts`, `src/storage/memory-store.ts`.

Why: LamedDB can later swap layouts and tiers without touching callers.
