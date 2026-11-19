# AGENTS.md

Instructions for coding agents working in this repo. The rules in [Project rules](#project-rules) are the review standards.

## Project

LamedDB is an adaptive cloud-native database: one API to write and query records, publish events, and subscribe to changes, plus a hosted MCP server. It picks layout, partitioning, tier, and indexes from the workload so application code never changes. Pilot users are B2B SaaS teams building bounded workflows such as orders, tickets, and activity feeds. What exists today is a `node:http` server (`src/cli.ts`, `src/http/server.ts`) in front of `CollectionService` (`src/collections/service.ts`) and the `Store` interface (`src/storage/store.ts`, with in-memory `MemoryStore` in `src/storage/memory-store.ts` as its only implementation), plus a TypeScript SDK (`src/sdk/client.ts`, exported from `src/index.ts`) that creates a collection and puts and gets records whose declared fields are `string`, `integer`, and `timestamp` (`src/types.ts`, checked in `src/validate.ts`). Queries, event publish, change subscriptions, the hosted MCP server, authentication, delete, conditional replace (`If-Match`), idempotency keys, and any durable store are not implemented yet; the live routes are `POST /v1/collections` and `PUT`/`GET /v1/collections/{name}/records/{id}` (`README.md`).

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

A header, query parameter, body field, or SDK option that asks for behavior this version does not implement is rejected with `400` and `LamedError` code `invalid_argument`, and storage is left unchanged. Copy `rejectUnsupportedPreconditions` and the unknown-key loop in `parseCreateCollectionBody` (`src/http/server.ts`): `If-Match` and `Idempotency-Key` fail on `POST /v1/collections` and on `PUT /v1/collections/{name}/records/{id}`, and a create body may contain only `name` and `fields`. `If-None-Match` accepts only a bare `*`, which is `PutOptions.createOnly` (`src/types.ts`), sent by `CollectionClient.put` in `src/sdk/client.ts`. Supported SDK options are `LamedDBOptions.baseUrl`, `LamedDBOptions.fetch`, `CollectionSpec.fields`, and `PutOptions.createOnly`. The rule covers API semantics: preconditions, idempotency, filters, extra fields, and extra options. Transport headers the server already honors (`content-type`, `host`, `content-length`) stay as they are.

Applies to: `src/http/server.ts`, `src/http/body.ts`, `src/sdk/client.ts`, `src/types.ts`.

Why: a client that believes a guarantee (for example idempotency or a precondition) holds when it does not is worse off than one that gets an error. Origin: Day 1 Qodo review found `POST /v1/collections` silently accepted `Idempotency-Key` and `If-Match`.

### Edge cases ship with the feature

Every new capability or fix includes tests for its failure paths — invalid input, missing resources, precondition failures, and limits — in the same change as the happy path. Cover the `400` / `404` / `409` / `412` responses the behavior can produce, and assert the stored data is unchanged when the call fails. Limits live in `LIMITS` in `src/validate.ts` (body size is 1 MiB via `src/http/body.ts`).

Applies to: `test/**/*.test.ts` (today `test/collections.test.ts`) for every change under `src/`.

Why: on Day 1 Qodo found 4 bugs, none covered by a test.

### Don't trust the types

Public exports and HTTP handlers validate input at runtime before using it. In `src/validate.ts`, `parseCollectionName` and `parseRecordId` take `unknown` and reject non-strings with `typeof`; `parseFieldDeclarations` and `validateDocument` require a plain object via `isPlainObject`. `parseCreateCollectionBody` in `src/http/server.ts` checks `body.name` with `typeof`. `readJsonBody` in `src/http/body.ts` checks `Content-Type` and `JSON.parse`. The `LamedDB` constructor in `src/sdk/client.ts` checks `baseUrl` with `typeof`. `CollectionService.createCollection` passes `spec.fields` as `unknown`, and `putRecord` passes `data` as `unknown`, into those parsers (`src/collections/service.ts`). Values that enter through `src/index.ts`, the SDK, or HTTP get these checks even when a TypeScript signature already names a type.

Applies to: `src/index.ts`, `src/http/server.ts`, `src/http/body.ts`, `src/collections/service.ts`, `src/validate.ts`, `src/sdk/client.ts`.

Why: JavaScript callers and raw HTTP clients bypass TypeScript.

### Every error gets a response

Errors return the `LamedError.toJSON()` envelope from `src/errors.ts` and the status on `LamedError.status`. The shape is `{ "error": { "code": ErrorCode, "message": string, "details"?: object } }`. `details` is omitted when absent. Codes and statuses: `invalid_argument` 400, `not_found` 404, `already_exists` 409, `precondition_failed` 412, `method_not_allowed` 405, `internal` 500. `handleRequest` in `src/http/server.ts` writes that JSON for a `LamedError` and for any other thrown value (`internal` / 500) through `writeJson` before it returns. An oversized body (`OversizedBodyError` in `src/http/body.ts`) pauses the request, `writeJson` sends the 400, and the socket is destroyed only in the `writeJson` flush callback.

Applies to: `src/http/server.ts` (`handleRequest`, `writeJson`), `src/http/body.ts`, `src/errors.ts`.

Why: the client has to receive the status and the error envelope. Destroying the socket before `writeJson` finishes drops that response.

### All storage goes through `Store`

Service and HTTP code depend on the `Store` interface in `src/storage/store.ts` (`createCollection`, `getCollection`, `putRecord`, `getRecord`). `CollectionService` takes a `Store` in its constructor. `route` and `handleRequest` call `CollectionService`. `putRecord` applies the write and the `createOnly` check atomically. A new layout or tier is a new class under `src/storage/` that implements `Store`, passed in as `listen({ store })` or `new CollectionService(store)`. The one `MemoryStore` construction in HTTP code is the default inside `listen` (`src/http/server.ts`), used when the caller passes neither `store` nor `service`.

Applies to: `src/collections/service.ts`, `src/http/server.ts`, `src/storage/store.ts`, `src/storage/memory-store.ts`.

Why: LamedDB can later swap layouts and tiers without touching callers.
