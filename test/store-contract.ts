import { beforeEach, describe, expect, it } from "vitest";

import { LamedError } from "../src/errors.js";
import { fieldValue } from "../src/storage/query.js";
import type {
  CollectionState,
  ListRecordsInput,
  ListRecordsResult,
  PutRecordInput,
  PutRecordResult,
  Store,
} from "../src/storage/store.js";
import type { AliasMap, ErrorCode, FieldMap, FieldType, JsonObject, JsonValue, RecordEnvelope } from "../src/index.js";
import type { ListPosition, RecordFilter, RecordSort } from "../src/storage/query.js";

/**
 * Knobs the contract moves while it checks expiry and the key cap.
 * Each call must return a new, empty store. `now` is the only clock the tests use.
 */
export interface StoreContractOptions {
  now?: () => number;
  idempotencyTtlMs?: number;
  maxIdempotencyKeys?: number;
}

const TTL_MS = 1_000;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  not_found: 404,
  already_exists: 409,
  idempotency_conflict: 409,
  precondition_failed: 412,
  method_not_allowed: 405,
  internal: 500,
};

const ORDER_FIELDS: FieldMap = {
  status: "string",
  totalCents: "integer",
  createdAt: "timestamp",
};

/**
 * Register the Store rules against one engine.
 * `createStore` is the only thing a later engine has to supply.
 */
export function runStoreContract(
  name: string,
  createStore: (options?: StoreContractOptions) => Store | Promise<Store>,
): void {
  const clock = { millis: 0 };

  describe(name, () => {
    let store: Store;

    beforeEach(async () => {
      clock.millis = 0;
      store = await createStore({
        now: () => clock.millis,
        idempotencyTtlMs: TTL_MS,
        maxIdempotencyKeys: 100,
      });
    });

    describe("collections and revision", () => {
      it("returns the revision from getCollection and omits it from the create payload", async () => {
        const created = await store.createCollection("orders", { status: "string" }, { state: "status" });

        expect(Object.hasOwn(created, "revision")).toBe(false);
        expect(created).toEqual({
          name: "orders",
          fields: { status: "string" },
          aliases: { state: "status" },
        });

        const loaded = await store.getCollection("orders");

        expect(loaded?.name).toBe("orders");
        expect(loaded?.fields).toEqual({ status: "string" });
        expect(loaded?.aliases).toEqual({ state: "status" });
        expect(Number.isSafeInteger(loaded?.revision)).toBe(true);
        expect(loaded?.revision).toBeGreaterThanOrEqual(0);

        const again = await store.getCollection("orders");

        expect(again?.revision).toBe(loaded?.revision);
      });

      it("omits aliases when none were declared", async () => {
        const created = await store.createCollection("orders", { status: "string" });

        expect(created.aliases).toBeUndefined();
        expect((await store.getCollection("orders"))?.aliases).toBeUndefined();
      });

      it("keeps a __proto__ field and a __proto__ alias as own data properties", async () => {
        const fields = ownRecord<FieldType>([
          ["status", "string"],
          ["__proto__", "integer"],
        ]);
        const created = await store.createCollection("orders", fields);

        expect(Object.getPrototypeOf(created.fields)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(created.fields, "__proto__")).toMatchObject({
          value: "integer",
          enumerable: true,
          writable: true,
          configurable: true,
        });
        expect(created.fields["__proto__"]).toBe("integer");
        expect(created.fields.status).toBe("string");

        const loaded = await store.getCollection("orders");

        if (loaded === null) {
          throw new Error("expected the collection to be stored");
        }

        expect(Object.getPrototypeOf(loaded.fields)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(loaded.fields, "__proto__")?.value).toBe("integer");

        const data = ownRecord<JsonValue>([
          ["status", "open"],
          ["__proto__", 4],
        ]);
        const written = await put(store, loaded, "a", data);
        const stored = await store.getRecord("orders", "a");

        expect(Object.getPrototypeOf(written.record.data)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(written.record.data, "__proto__")?.value).toBe(4);
        expect(Object.getOwnPropertyDescriptor(stored?.data ?? {}, "__proto__")?.value).toBe(4);
        expect(stored?.data.status).toBe("open");

        const aliases = ownRecord([["__proto__", "status"]]);
        const aliased = await store.createCollection("tickets", { status: "string" }, aliases);

        if (aliased.aliases === undefined) {
          throw new Error("expected the alias to be returned");
        }

        expect(Object.getPrototypeOf(aliased.aliases)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(aliased.aliases, "__proto__")).toMatchObject({
          value: "status",
          enumerable: true,
          writable: true,
          configurable: true,
        });

        const tickets = await store.getCollection("tickets");

        if (tickets?.aliases === undefined) {
          throw new Error("expected the alias to be stored");
        }

        expect(Object.getPrototypeOf(tickets.aliases)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(tickets.aliases, "__proto__")?.value).toBe("status");
      });

      it("keeps a caller's later edits to fields and aliases off the stored collection", async () => {
        const fields: Record<string, "string" | "integer"> = { status: "string" };
        const aliases: Record<string, string> = { state: "status" };

        await store.createCollection("orders", fields, aliases);
        fields.status = "integer";
        aliases.state = "missing";

        const loaded = await store.getCollection("orders");

        expect(loaded?.fields).toEqual({ status: "string" });
        expect(loaded?.aliases).toEqual({ state: "status" });

        if (loaded?.fields) {
          (loaded.fields as Record<string, string>).status = "integer";
        }

        if (loaded?.aliases) {
          (loaded.aliases as Record<string, string>).state = "missing";
        }

        const reread = await store.getCollection("orders");

        expect(reread?.fields).toEqual({ status: "string" });
        expect(reread?.aliases).toEqual({ state: "status" });
      });

      it("gives a recreated name a new revision and rejects the previous one", async () => {
        const first = await collection(store, "orders", { status: "string" });
        const tickets = await collection(store, "tickets", { status: "string" });

        expect(tickets.revision).not.toBe(first.revision);
        expect(await store.deleteCollection("orders")).toBe(true);

        const second = await collection(store, "orders", { status: "string" });

        expect(second.revision).not.toBe(first.revision);
        expect((await store.getCollection("tickets"))?.revision).toBe(tickets.revision);
        await expect(
          put(store, { ...second, revision: first.revision }, "a", { status: "open" }),
        ).rejects.toMatchObject(rejection("not_found"));
        expect(await store.getRecord("orders", "a")).toBeNull();
        await expect(list(store, { ...second, revision: first.revision })).rejects.toMatchObject(
          rejection("not_found"),
        );
        expect(await list(store, second)).toEqual({ records: [], hasMore: false });
      });

      it("rejects a duplicate name and leaves the original collection in place", async () => {
        const created = await collection(store, "orders", { status: "string" }, { state: "status" });

        await expect(
          store.createCollection("orders", { status: "integer" }),
        ).rejects.toMatchObject(rejection("already_exists"));

        expect(await store.getCollection("orders")).toEqual({
          name: "orders",
          fields: { status: "string" },
          aliases: { state: "status" },
          revision: created.revision,
        });
      });

      it("returns false when deleting a missing collection and leaves another collection alone", async () => {
        const tickets = await collection(store, "tickets", { status: "string" });
        const written = await put(store, tickets, "a", { status: "open" });

        expect(await store.deleteCollection("orders")).toBe(false);
        expect(await store.getCollection("orders")).toBeNull();
        expect(await store.getRecord("tickets", "a")).toEqual(written.record);
      });
    });

    describe("putRecord", () => {
      it("creates a record at version 1 and replaces it with the new document", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);
        const data = { status: "open", totalCents: 100, note: "keep" };
        const created = await put(store, orders, "a", data);

        data.status = "tampered";
        data.note = "changed";

        expect(created).toEqual({
          created: true,
          record: { id: "a", version: 1, data: { status: "open", totalCents: 100, note: "keep" } },
        });
        expect(await store.getRecord("orders", "a")).toEqual(created.record);

        const replaced = await put(store, orders, "a", { status: "paid" });

        expect(replaced.created).toBe(false);
        expect(replaced.record).toEqual({ id: "a", version: 2, data: { status: "paid" } });
        expect(await store.getRecord("orders", "a")).toEqual(replaced.record);
        expect(await store.getRecord("orders", "missing")).toBeNull();
      });

      it("keeps a returned record stable when the stored document is replaced", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" });

        await put(store, orders, "a", { status: "paid" });
        created.record.data.status = "tampered";

        expect(await store.getRecord("orders", "a")).toEqual({
          id: "a",
          version: 2,
          data: { status: "paid" },
        });
      });

      it("rejects a write for a missing collection and does not create it", async () => {
        await expect(
          store.putRecord({
            collection: "orders",
            id: "a",
            data: { status: "open" },
            createOnly: false,
            collectionRevision: 1,
          }),
        ).rejects.toMatchObject(rejection("not_found"));
        expect(await store.getCollection("orders")).toBeNull();
      });

      it("rejects a document checked against a collection that has since been replaced", async () => {
        const first = await collection(store, "orders", { status: "string" });

        expect(await store.deleteCollection("orders")).toBe(true);

        const second = await collection(store, "orders", { status: "string" });
        const kept = await put(store, second, "kept", { status: "open" });

        await expect(put(store, first, "a", { status: "open" })).rejects.toMatchObject(rejection("not_found"));
        expect(await store.getRecord("orders", "a")).toBeNull();
        expect(await store.getRecord("orders", "kept")).toEqual(kept.record);
      });

      it("rejects a NUL character in a document and does not write or store the key", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);

        await expect(put(store, orders, "a", { status: "a\u0000b" })).rejects.toMatchObject({
          ...rejection("invalid_argument"),
          message: "String at $.status must not contain a NUL character.",
        });
        expect(await store.getRecord("orders", "a")).toBeNull();

        const cases: readonly { data: JsonObject; message: string }[] = [
          {
            data: { status: "open", note: "a\u0000" },
            message: "String at $.note must not contain a NUL character.",
          },
          {
            data: { status: "open", extra: { note: "a\u0000" } },
            message: "String at $.extra.note must not contain a NUL character.",
          },
          {
            data: { status: "open", tags: ["ok", "a\u0000"] },
            message: "String at $.tags[1] must not contain a NUL character.",
          },
          {
            data: ownRecord<JsonValue>([
              ["status", "open"],
              ["a\u0000", 1],
            ]),
            message: "Object key at $ must not contain a NUL character.",
          },
          {
            data: nestedNulKey(),
            message: "Object key at $.extra must not contain a NUL character.",
          },
        ];

        for (const entry of cases) {
          await expect(
            put(store, orders, "a", entry.data, {
              idempotency: { key: "once", fingerprint: entry.message },
            }),
          ).rejects.toMatchObject({
            ...rejection("invalid_argument"),
            message: entry.message,
          });
          expect(await store.getRecord("orders", "a")).toBeNull();
        }

        const written = await put(
          store,
          orders,
          "a",
          { status: "open\n\u0001" },
          { idempotency: { key: "once", fingerprint: "ok" } },
        );

        expect(written.record.data.status).toBe("open\n\u0001");
        expect(await store.getRecord("orders", "a")).toEqual(written.record);
      });
    });

    describe("createOnly and ifVersion", () => {
      it("creates only when the id is absent and leaves an existing record unchanged", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" }, { createOnly: true });

        expect(created).toEqual({
          created: true,
          record: { id: "a", version: 1, data: { status: "open" } },
        });
        await expect(
          put(store, orders, "a", { status: "paid" }, { createOnly: true }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        expect(await store.getRecord("orders", "a")).toEqual(created.record);
      });

      it("replaces a record only when ifVersion is its current version", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" });

        await expect(
          put(store, orders, "missing", { status: "open" }, { ifVersion: 1 }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        await expect(
          put(store, orders, "a", { status: "stale" }, { ifVersion: 0 }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        expect(await store.getRecord("orders", "a")).toEqual(created.record);
        expect(await store.getRecord("orders", "missing")).toBeNull();

        const replaced = await put(store, orders, "a", { status: "paid" }, { ifVersion: 1 });

        expect(replaced).toEqual({
          created: false,
          record: { id: "a", version: 2, data: { status: "paid" } },
        });
        await expect(
          put(store, orders, "a", { status: "again" }, { ifVersion: 1 }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        expect(await store.getRecord("orders", "a")).toEqual(replaced.record);
      });

      it("rejects ifVersion together with createOnly and does not write", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" });

        await expect(
          put(store, orders, "a", { status: "paid" }, { createOnly: true, ifVersion: 1 }),
        ).rejects.toMatchObject(rejection("invalid_argument"));
        await expect(
          put(store, orders, "b", { status: "open" }, { createOnly: true, ifVersion: 1 }),
        ).rejects.toMatchObject(rejection("invalid_argument"));
        expect(await store.getRecord("orders", "a")).toEqual(created.record);
        expect(await store.getRecord("orders", "b")).toBeNull();
      });

      it("lets exactly one of two concurrent puts with the same ifVersion succeed", async () => {
        const orders = await collection(store, "orders", { status: "string" });

        await put(store, orders, "a", { status: "open" }, { idempotency: { key: "seed", fingerprint: "seed" } });

        const attempts = await Promise.allSettled([
          put(store, orders, "a", { status: "left" }, { ifVersion: 1, idempotency: { key: "left", fingerprint: "left" } }),
          put(store, orders, "a", { status: "right" }, { ifVersion: 1, idempotency: { key: "right", fingerprint: "right" } }),
        ]);
        const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
        const failed = attempts.filter((attempt) => attempt.status === "rejected");

        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);

        const loser = failed[0];

        expect(loser?.status).toBe("rejected");

        if (loser?.status === "rejected") {
          expect(loser.reason).toBeInstanceOf(LamedError);
          expect(loser.reason).toMatchObject(rejection("precondition_failed"));
        }

        const stored = await store.getRecord("orders", "a");

        expect(stored?.version).toBe(2);
        expect(["left", "right"]).toContain(stored?.data.status);

        const winner = succeeded[0];
        const winnerKey = stored?.data.status === "left" ? "left" : "right";

        if (winner?.status === "fulfilled") {
          expect(stored).toEqual(winner.value.record);

          const replay = await put(store, orders, "a", { status: winnerKey }, {
            ifVersion: 1,
            idempotency: { key: winnerKey, fingerprint: winnerKey },
          });

          expect(replay.record).toEqual(winner.value.record);
        }

        const loserKey = winnerKey === "left" ? "right" : "left";
        const corrected = await put(store, orders, "a", { status: "corrected" }, {
          ifVersion: 2,
          idempotency: { key: loserKey, fingerprint: loserKey },
        });

        expect(corrected.record).toEqual({ id: "a", version: 3, data: { status: "corrected" } });
      });

      it("lets exactly one of two concurrent createOnly puts succeed", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const attempts = await Promise.allSettled([
          put(store, orders, "a", { status: "left" }, { createOnly: true }),
          put(store, orders, "a", { status: "right" }, { createOnly: true }),
        ]);
        const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
        const failed = attempts.filter((attempt) => attempt.status === "rejected");

        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);

        const loser = failed[0];

        if (loser?.status === "rejected") {
          expect(loser.reason).toMatchObject(rejection("precondition_failed"));
        }

        const stored = await store.getRecord("orders", "a");

        expect(stored?.version).toBe(1);
        expect(["left", "right"]).toContain(stored?.data.status);
      });
    });

    describe("deleteRecord", () => {
      it("continues versions at last + 1 and returns false for a missing id", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" });

        await put(store, orders, "a", { status: "paid" });
        expect(await store.deleteRecord("orders", "missing")).toBe(false);
        expect(await store.deleteRecord("orders", "a")).toBe(true);
        expect(await store.deleteRecord("orders", "a")).toBe(false);
        expect(await store.getRecord("orders", "a")).toBeNull();

        await expect(
          put(store, orders, "a", { status: "back" }, { ifVersion: created.record.version }),
        ).rejects.toMatchObject(rejection("precondition_failed"));

        const recreated = await put(store, orders, "a", { status: "back" }, { createOnly: true });

        expect(recreated).toEqual({
          created: true,
          record: { id: "a", version: 3, data: { status: "back" } },
        });
      });

      it("throws not_found when the collection is missing and does not affect another collection", async () => {
        const tickets = await collection(store, "tickets", { status: "string" });
        const written = await put(store, tickets, "a", { status: "open" });

        await expect(store.deleteRecord("orders", "a")).rejects.toMatchObject(rejection("not_found"));
        expect(await store.getRecord("tickets", "a")).toEqual(written.record);
      });
    });

    describe("listRecords", () => {
      it("returns a sorted page with hasMore, and nothing strictly after the end", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);

        await put(store, orders, "m", { status: "open", totalCents: 10 });
        await put(store, orders, "a", { status: "paid", totalCents: 2 });
        await put(store, orders, "z", { status: "open", totalCents: 3 });

        const first = await list(store, orders, { limit: 2 });

        expect(first.hasMore).toBe(true);
        expect(first.records.map((record) => record.id)).toEqual(["a", "m"]);

        const last = first.records[1];

        if (!last) {
          throw new Error("expected a second record");
        }

        const second = await list(store, orders, { limit: 2, after: position(last, { field: "id", direction: "asc" }) });

        expect(second).toEqual({
          records: [expect.objectContaining({ id: "z", version: 1 })],
          hasMore: false,
        });

        const done = await list(store, orders, {
          limit: 2,
          after: position(second.records[0] as RecordEnvelope, { field: "id", direction: "asc" }),
        });

        expect(done).toEqual({ records: [], hasMore: false });
        expect(await list(store, orders, { limit: 10 })).toMatchObject({ hasMore: false });
        expect((await list(store, orders, { limit: 10 })).records).toHaveLength(3);
      });

      it("sorts by the field numerically, then by ascending id, with missing values first or last", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);
        const rows: [string, JsonObject][] = [
          ["b", { status: "open", totalCents: 10 }],
          ["a", { status: "open", totalCents: 2 }],
          ["c", { status: "open", totalCents: 10 }],
          ["d", { status: "open", totalCents: 3 }],
          ["e", { status: "open" }],
        ];

        for (const [id, data] of rows) {
          await put(store, orders, id, data);
        }

        expect(ids(await list(store, orders, { sort: { field: "totalCents", direction: "asc" }, limit: 10 }))).toEqual([
          "e",
          "a",
          "d",
          "b",
          "c",
        ]);
        expect(ids(await list(store, orders, { sort: { field: "totalCents", direction: "desc" }, limit: 10 }))).toEqual([
          "b",
          "c",
          "d",
          "a",
          "e",
        ]);
        expect(ids(await list(store, orders, { sort: { field: "id", direction: "desc" }, limit: 2 }))).toEqual(["e", "d"]);
      });

      it("sorts timestamps in chronological order", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);

        await put(store, orders, "b", { status: "open", createdAt: "2026-11-02T00:00:00.000Z" });
        await put(store, orders, "a", { status: "open", createdAt: "2026-01-01T00:00:00.000Z" });
        await put(store, orders, "c", { status: "open" });

        expect(
          ids(await list(store, orders, { sort: { field: "createdAt", direction: "asc" }, limit: 10 })),
        ).toEqual(["c", "a", "b"]);
      });

      it("applies every filter, and hasMore ignores records that do not match", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);

        await put(store, orders, "a", { status: "open", totalCents: 500 });
        await put(store, orders, "b", { status: "paid", totalCents: 1500 });
        await put(store, orders, "c", { status: "open", totalCents: 1500 });
        await put(store, orders, "d", { status: "open", totalCents: 2500 });
        await put(store, orders, "e", { status: null });
        await put(store, orders, "f", { totalCents: 1500 });
        await put(store, orders, "prefix", { status: "opening" });

        const open = await list(store, orders, {
          limit: 1,
          filters: [
            { field: "status", op: "eq", value: "open" },
            { field: "totalCents", op: "gte", value: 1000 },
            { field: "totalCents", op: "lt", value: 2000 },
          ],
        });

        expect(ids(open)).toEqual(["c"]);
        expect(open.hasMore).toBe(false);

        expect(
          ids(
            await list(store, orders, {
              limit: 10,
              filters: [{ field: "status", op: "in", value: ["paid", "opening"] }],
            }),
          ),
        ).toEqual(["b", "prefix"]);
        expect(
          ids(await list(store, orders, { limit: 10, filters: [{ field: "status", op: "prefix", value: "open" }] })),
        ).toEqual(["a", "c", "d", "prefix"]);
        expect(
          ids(await list(store, orders, { limit: 10, filters: [{ field: "status", op: "eq", value: null }] })),
        ).toEqual(["e", "f"]);
        expect(
          ids(await list(store, orders, { limit: 10, filters: [{ field: "status", op: "ne", value: "open" }] })),
        ).toEqual(["b", "e", "f", "prefix"]);
        expect(
          ids(await list(store, orders, { limit: 10, filters: [{ field: "status", op: "ne", value: null }] })),
        ).toEqual(["a", "b", "c", "d", "prefix"]);
        expect(
          ids(
            await list(store, orders, {
              limit: 10,
              filters: [{ field: "totalCents", op: "gt", value: 1500 }],
            }),
          ),
        ).toEqual(["d"]);
        expect(
          ids(
            await list(store, orders, {
              limit: 10,
              filters: [{ field: "totalCents", op: "lte", value: 500 }],
            }),
          ),
        ).toEqual(["a"]);
        expect(
          await list(store, orders, { limit: 10, filters: [{ field: "status", op: "eq", value: "held" }] }),
        ).toEqual({ records: [], hasMore: false });
      });

      it("returns an empty collection as an empty page", async () => {
        const orders = await collection(store, "orders", { status: "string" });

        expect(await list(store, orders)).toEqual({ records: [], hasMore: false });
      });

      it("throws not_found for a missing collection or a stale revision and does not leak the new records", async () => {
        const first = await collection(store, "orders", ORDER_FIELDS);

        await put(store, first, "old", { status: "open" });
        expect(await store.deleteCollection("orders")).toBe(true);
        await expect(list(store, first)).rejects.toMatchObject(rejection("not_found"));

        const second = await collection(store, "orders", ORDER_FIELDS);

        await put(store, second, "new", { status: "open" });
        await expect(list(store, first)).rejects.toMatchObject(rejection("not_found"));
        expect(ids(await list(store, second))).toEqual(["new"]);
        await expect(list(store, { ...second, name: "missing" })).rejects.toMatchObject(rejection("not_found"));
      });

      it("holds no page state, so a later call sees writes that happened after the previous page", async () => {
        const orders = await collection(store, "orders", { status: "string" });

        await put(store, orders, "b", { status: "open" });
        await put(store, orders, "c", { status: "open" });

        const first = await list(store, orders, { limit: 1 });

        expect(ids(first)).toEqual(["b"]);
        await put(store, orders, "a", { status: "open" });

        const again = await list(store, orders, { limit: 1 });

        expect(ids(again)).toEqual(["a"]);
        expect(first.records[0]?.data).toEqual({ status: "open" });
      });

      it("returns each record that existed for the whole walk exactly once", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);
        const sort: RecordSort = { field: "id", direction: "asc" };

        for (const id of ["a", "b", "c", "d", "e", "f"]) {
          await put(store, orders, id, { status: "open", totalCents: 1 });
        }

        const seen = await walk(store, orders, { limit: 2, sort }, async (_page, index) => {
          if (index !== 0) {
            return;
          }

          await store.deleteRecord("orders", "b");
          await store.deleteRecord("orders", "d");
          await put(store, orders, "c", { status: "paid", totalCents: 9 });
          await put(store, orders, "aa", { status: "open", totalCents: 1 });
          await put(store, orders, "z", { status: "open", totalCents: 1 });
        });

        expect(seen.map((record) => record.id)).toEqual(["a", "b", "c", "e", "f", "z"]);
        expect(seen.find((record) => record.id === "c")?.version).toBe(2);
        expect(seen.find((record) => record.id === "c")?.data).toEqual({ status: "paid", totalCents: 9 });
        expect(new Set(seen.map((record) => record.id)).size).toBe(seen.length);
      });

      it("keeps an unchanged filtered record exactly once when other records change mid-walk", async () => {
        const orders = await collection(store, "orders", ORDER_FIELDS);
        const sort: RecordSort = { field: "totalCents", direction: "asc" };
        const filters: RecordFilter[] = [{ field: "status", op: "eq", value: "open" }];

        await put(store, orders, "e", { status: "open" });
        await put(store, orders, "a", { status: "open", totalCents: 1 });
        await put(store, orders, "c", { status: "open", totalCents: 1 });
        await put(store, orders, "d", { status: "open", totalCents: 3 });
        await put(store, orders, "b", { status: "paid", totalCents: 2 });

        const seen = await walk(store, orders, { limit: 1, sort, filters }, async (_page, index) => {
          if (index !== 0) {
            return;
          }

          await store.deleteRecord("orders", "d");
          await put(store, orders, "c", { status: "paid", totalCents: 1 });
          await put(store, orders, "a", { status: "open", totalCents: 1, note: "same place" });
          await put(store, orders, "f", { status: "open", totalCents: 0 });
          await put(store, orders, "aaa", { status: "open" });
        });

        expect(seen.map((record) => record.id)).toEqual(["e", "f", "a"]);
        expect(seen.find((record) => record.id === "a")?.version).toBe(2);
        expect(seen.find((record) => record.id === "a")?.data).toEqual({
          status: "open",
          totalCents: 1,
          note: "same place",
        });
      });
    });

    describe("idempotency", () => {
      it("replays the original result and does not write again", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const key = { key: "same", fingerprint: "create-open" };
        const created = await put(store, orders, "a", { status: "open", note: "a" }, { idempotency: key });

        created.record.data.note = "tampered";

        const replayed = await put(store, orders, "a", { note: "a", status: "open" }, { idempotency: key });

        expect(replayed).toEqual({
          created: true,
          record: { id: "a", version: 1, data: { status: "open", note: "a" } },
        });
        expect(await store.getRecord("orders", "a")).toEqual(replayed.record);

        const replaced = await put(store, orders, "a", { status: "paid" });
        const replayAfterReplace = await put(store, orders, "a", { status: "open", note: "a" }, { idempotency: key });

        expect(replayAfterReplace).toEqual({
          created: true,
          record: { id: "a", version: 1, data: { status: "open", note: "a" } },
        });
        expect(await store.getRecord("orders", "a")).toEqual(replaced.record);

        const replaceKey = { key: "replace", fingerprint: "replace-paid" };
        const conditional = await put(store, orders, "a", { status: "held" }, { ifVersion: 2, idempotency: replaceKey });
        const conditionalReplay = await put(
          store,
          orders,
          "a",
          { status: "held" },
          { ifVersion: 2, idempotency: replaceKey },
        );

        expect(conditionalReplay).toEqual(conditional);
        expect(conditional.record.version).toBe(3);
        expect(await store.getRecord("orders", "a")).toEqual(conditional.record);
      });

      it("replays createOnly instead of failing the precondition on the retry", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const key = { key: "once", fingerprint: "create-only" };
        const created = await put(store, orders, "a", { status: "open" }, { createOnly: true, idempotency: key });
        const replayed = await put(store, orders, "a", { status: "open" }, { createOnly: true, idempotency: key });

        expect(replayed).toEqual(created);
        expect(await store.getRecord("orders", "a")).toEqual(created.record);
      });

      it("conflicts when a live key is reused for a different request and writes nothing", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const tickets = await collection(store, "tickets", { status: "string" });
        const key = { key: "shared", fingerprint: "orders-a-open" };
        const created = await put(store, orders, "a", { status: "open" }, { idempotency: key });
        const other = await put(store, orders, "b", { status: "held" });

        await expect(
          put(store, orders, "a", { status: "paid" }, { idempotency: { key: "shared", fingerprint: "other-body" } }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));
        await expect(
          put(store, orders, "c", { status: "open" }, { idempotency: { key: "shared", fingerprint: "other-id" } }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));
        await expect(
          put(store, orders, "a", { status: "open" }, {
            createOnly: true,
            idempotency: { key: "shared", fingerprint: "other-options" },
          }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));

        const elsewhere = await put(store, tickets, "a", { status: "open" }, {
          idempotency: { key: "shared", fingerprint: "tickets" },
        });

        expect(await store.getRecord("orders", "a")).toEqual(created.record);
        expect(await store.getRecord("orders", "b")).toEqual(other.record);
        expect(await store.getRecord("orders", "c")).toBeNull();
        expect(await store.getRecord("tickets", "a")).toEqual(elsewhere.record);
      });

      it("does not record a failed put, so the same key can succeed once the request is fixed", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const created = await put(store, orders, "a", { status: "open" });
        const key = { key: "retry", fingerprint: "will-fail" };

        await expect(
          put(store, orders, "a", { status: "paid" }, { createOnly: true, idempotency: key }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        await expect(
          put(store, orders, "missing", { status: "open" }, { ifVersion: 1, idempotency: key }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        await expect(
          put(store, { ...orders, revision: orders.revision + 1 }, "a", { status: "paid" }, { idempotency: key }),
        ).rejects.toMatchObject(rejection("not_found"));
        expect(await store.getRecord("orders", "a")).toEqual(created.record);

        const written = await put(store, orders, "a", { status: "paid" }, { idempotency: key });

        expect(written.record).toEqual({ id: "a", version: 2, data: { status: "paid" } });
        expect(await put(store, orders, "a", { status: "paid" }, { idempotency: key })).toEqual(written);
        expect(await store.getRecord("orders", "a")).toEqual(written.record);
      });

      it("writes one record when concurrent puts share a key, and one conflict when they do not", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const same = await Promise.all([
          put(store, orders, "a", { status: "open" }, { idempotency: { key: "same", fingerprint: "fp" } }),
          put(store, orders, "a", { status: "open" }, { idempotency: { key: "same", fingerprint: "fp" } }),
        ]);

        expect(same[0]).toEqual(same[1]);
        expect(same[0]?.record.version).toBe(1);
        expect(await store.getRecord("orders", "a")).toEqual(same[0]?.record);

        const raced = await Promise.allSettled([
          put(store, orders, "b", { status: "left" }, { idempotency: { key: "race", fingerprint: "left" } }),
          put(store, orders, "b", { status: "right" }, { idempotency: { key: "race", fingerprint: "right" } }),
        ]);
        const succeeded = raced.filter((attempt) => attempt.status === "fulfilled");
        const failed = raced.filter((attempt) => attempt.status === "rejected");

        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);

        const loser = failed[0];

        if (loser?.status === "rejected") {
          expect(loser.reason).toMatchObject(rejection("idempotency_conflict"));
        }

        const stored = await store.getRecord("orders", "b");

        expect(stored?.version).toBe(1);
        expect(["left", "right"]).toContain(stored?.data.status);
      });

      it("replays a live key just before the TTL and processes it again at expiry", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const key = { key: "timed", fingerprint: "open" };
        const created = await put(store, orders, "a", { status: "open" }, { idempotency: key });

        clock.millis = 400;
        expect(await put(store, orders, "a", { status: "open" }, { idempotency: key })).toEqual(created);

        clock.millis = TTL_MS - 1;
        await expect(
          put(store, orders, "a", { status: "paid" }, { idempotency: { key: "timed", fingerprint: "paid" } }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));
        expect(await store.getRecord("orders", "a")).toEqual(created.record);

        clock.millis = TTL_MS;

        const expired = await put(store, orders, "a", { status: "paid" }, {
          idempotency: { key: "timed", fingerprint: "paid" },
        });

        expect(expired.record).toEqual({ id: "a", version: 2, data: { status: "paid" } });
        expect(await store.getRecord("orders", "a")).toEqual(expired.record);
      });

      it("does not extend a key's life when it is replayed", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const key = { key: "aged", fingerprint: "open" };
        const created = await put(store, orders, "a", { status: "open" }, { idempotency: key });

        clock.millis = TTL_MS - 1;
        expect(await put(store, orders, "a", { status: "open" }, { idempotency: key })).toEqual(created);

        clock.millis = TTL_MS;

        const expired = await put(store, orders, "a", { status: "paid" }, { idempotency: key });

        expect(expired.record.version).toBe(2);
        expect(await store.getRecord("orders", "a")).toEqual(expired.record);
      });

      it("keeps a key live when the clock moves backwards", async () => {
        clock.millis = 1_000;

        const orders = await collection(store, "orders", { status: "string" });
        const first = await put(store, orders, "a", { status: "open" }, {
          idempotency: { key: "back", fingerprint: "open" },
        });

        clock.millis = 0;

        const second = await put(store, orders, "b", { status: "open" }, {
          idempotency: { key: "later", fingerprint: "open" },
        });

        clock.millis = 1_000;
        expect(
          await put(store, orders, "a", { status: "open" }, { idempotency: { key: "back", fingerprint: "open" } }),
        ).toEqual(first);
        expect(
          await put(store, orders, "b", { status: "open" }, { idempotency: { key: "later", fingerprint: "open" } }),
        ).toEqual(second);

        clock.millis = 1_000 + TTL_MS - 1;
        expect(
          await put(store, orders, "a", { status: "open" }, { idempotency: { key: "back", fingerprint: "open" } }),
        ).toEqual(first);
        expect(
          await put(store, orders, "b", { status: "open" }, { idempotency: { key: "later", fingerprint: "open" } }),
        ).toEqual(second);

        clock.millis = 1_000 + TTL_MS;

        expect(
          (await put(store, orders, "b", { status: "paid" }, { idempotency: { key: "later", fingerprint: "open" } }))
            .record.version,
        ).toBe(2);
        expect(
          (await put(store, orders, "a", { status: "paid" }, { idempotency: { key: "back", fingerprint: "open" } }))
            .record.version,
        ).toBe(2);
      });

      it("drops the oldest key in that collection and does not refresh it on replay", async () => {
        const capped = await createStore({
          now: () => clock.millis,
          idempotencyTtlMs: TTL_MS,
          maxIdempotencyKeys: 2,
        });
        const orders = await collection(capped, "orders", { status: "string" });
        const tickets = await collection(capped, "tickets", { status: "string" });

        clock.millis = 0;
        const oldest = await put(capped, orders, "a", { status: "open" }, {
          idempotency: { key: "a", fingerprint: "open" },
        });

        clock.millis = 1;
        const kept = await put(capped, orders, "b", { status: "open" }, {
          idempotency: { key: "b", fingerprint: "open" },
        });
        const ticket = await put(capped, tickets, "a", { status: "open" }, {
          idempotency: { key: "a", fingerprint: "open" },
        });

        clock.millis = 2;
        expect(
          await put(capped, orders, "a", { status: "open" }, { idempotency: { key: "a", fingerprint: "open" } }),
        ).toEqual(oldest);

        clock.millis = 3;
        const added = await put(capped, orders, "c", { status: "open" }, {
          idempotency: { key: "c", fingerprint: "open" },
        });

        expect(added.record.version).toBe(1);
        expect(
          await put(capped, orders, "b", { status: "open" }, { idempotency: { key: "b", fingerprint: "open" } }),
        ).toEqual(kept);

        const evicted = await put(capped, orders, "a", { status: "paid" }, {
          idempotency: { key: "a", fingerprint: "paid" },
        });

        expect(evicted.record).toEqual({ id: "a", version: 2, data: { status: "paid" } });
        expect(
          await put(capped, tickets, "a", { status: "open" }, { idempotency: { key: "a", fingerprint: "open" } }),
        ).toEqual(ticket);
        expect(oldest.record.version).toBe(1);
      });

      it("does not let an expired key take a live key's slot", async () => {
        const capped = await createStore({
          now: () => clock.millis,
          idempotencyTtlMs: TTL_MS,
          maxIdempotencyKeys: 2,
        });
        const orders = await collection(capped, "orders", { status: "string" });

        clock.millis = 0;
        await put(capped, orders, "a", { status: "old" }, { idempotency: { key: "a", fingerprint: "old" } });

        clock.millis = 10;
        const live = await put(capped, orders, "b", { status: "live" }, {
          idempotency: { key: "b", fingerprint: "live" },
        });

        clock.millis = TTL_MS;
        const added = await put(capped, orders, "c", { status: "new" }, {
          idempotency: { key: "c", fingerprint: "new" },
        });

        expect(added.record.version).toBe(1);
        expect(
          await put(capped, orders, "b", { status: "live" }, { idempotency: { key: "b", fingerprint: "live" } }),
        ).toEqual(live);

        const expired = await put(capped, orders, "a", { status: "old" }, {
          idempotency: { key: "a", fingerprint: "old" },
        });

        expect(expired.record.version).toBe(2);
      });

      it("does not evict a live key when the new put fails or conflicts", async () => {
        const capped = await createStore({
          now: () => clock.millis,
          idempotencyTtlMs: TTL_MS,
          maxIdempotencyKeys: 1,
        });
        const orders = await collection(capped, "orders", { status: "string" });
        const created = await put(capped, orders, "a", { status: "open" }, {
          idempotency: { key: "kept", fingerprint: "open" },
        });

        await expect(
          put(capped, orders, "a", { status: "paid" }, { idempotency: { key: "kept", fingerprint: "paid" } }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));
        await expect(
          put(capped, orders, "a", { status: "paid" }, {
            createOnly: true,
            idempotency: { key: "fresh", fingerprint: "fresh" },
          }),
        ).rejects.toMatchObject(rejection("precondition_failed"));
        expect(
          await put(capped, orders, "a", { status: "open" }, { idempotency: { key: "kept", fingerprint: "open" } }),
        ).toEqual(created);
        expect(await capped.getRecord("orders", "a")).toEqual(created.record);
      });

      it("keeps idempotency keys when a record is deleted and does not recreate it on replay", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const key = { key: "kept", fingerprint: "open" };
        const created = await put(store, orders, "a", { status: "open" }, { idempotency: key });

        expect(await store.deleteRecord("orders", "a")).toBe(true);

        const replayed = await put(store, orders, "a", { status: "open" }, { idempotency: key });

        expect(replayed).toEqual(created);
        expect(await store.getRecord("orders", "a")).toBeNull();
        await expect(
          put(store, orders, "a", { status: "paid" }, { idempotency: { key: "kept", fingerprint: "paid" } }),
        ).rejects.toMatchObject(rejection("idempotency_conflict"));
        expect(await store.getRecord("orders", "a")).toBeNull();

        const recreated = await put(store, orders, "a", { status: "back" });

        expect(recreated.record.version).toBe(2);
      });
    });

    describe("deleteCollection", () => {
      it("drops that collection's records, version counters, and keys, and nothing else", async () => {
        const orders = await collection(store, "orders", { status: "string" });
        const tickets = await collection(store, "tickets", { status: "string" });
        const shared = { key: "shared", fingerprint: "open" };

        await put(store, orders, "a", { status: "open" }, { idempotency: shared });
        await put(store, orders, "a", { status: "paid" });

        const ticket = await put(store, tickets, "a", { status: "open" }, { idempotency: shared });

        expect(await store.deleteCollection("orders")).toBe(true);
        expect(await store.getCollection("orders")).toBeNull();
        expect(await store.getRecord("orders", "a")).toBeNull();
        await expect(list(store, orders)).rejects.toMatchObject(rejection("not_found"));
        expect(await store.deleteCollection("orders")).toBe(false);

        const recreated = await collection(store, "orders", { status: "string" });
        const again = await put(store, recreated, "a", { status: "open" }, { idempotency: shared });

        expect(again.record).toEqual({ id: "a", version: 1, data: { status: "open" } });
        expect(await store.getRecord("tickets", "a")).toEqual(ticket.record);
        expect(await put(store, tickets, "a", { status: "open" }, { idempotency: shared })).toEqual(ticket);
        expect((await store.getCollection("tickets"))?.revision).toBe(tickets.revision);
      });
    });
  });
}

function ownRecord<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const record: Record<string, T> = {};

  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return record;
}

function nestedNulKey(): JsonObject {
  const extra: JsonObject = {};

  Object.defineProperty(extra, "a\u0000", {
    value: true,
    enumerable: true,
    writable: true,
    configurable: true,
  });

  return { status: "open", extra };
}

function rejection(code: ErrorCode): { code: ErrorCode; status: number } {
  return { code, status: STATUS_BY_CODE[code] };
}

async function collection(
  store: Store,
  name: string,
  fields: FieldMap,
  aliases?: AliasMap,
): Promise<CollectionState> {
  await store.createCollection(name, fields, aliases);

  const stored = await store.getCollection(name);

  if (!stored) {
    throw new Error(`Collection "${name}" was not stored.`);
  }

  return stored;
}

function put(
  store: Store,
  stored: CollectionState,
  id: string,
  data: JsonObject,
  extra: Partial<PutRecordInput> = {},
): Promise<PutRecordResult> {
  return store.putRecord({
    collection: stored.name,
    id,
    data,
    createOnly: false,
    collectionRevision: stored.revision,
    ...extra,
  });
}

function list(
  store: Store,
  stored: CollectionState,
  extra: Partial<ListRecordsInput> = {},
): Promise<ListRecordsResult> {
  return store.listRecords({
    collection: stored.name,
    collectionRevision: stored.revision,
    filters: [],
    sort: { field: "id", direction: "asc" },
    limit: 50,
    ...extra,
  });
}

function position(record: RecordEnvelope, sort: RecordSort): ListPosition {
  return { id: record.id, value: fieldValue(record, sort.field) ?? null };
}

function ids(page: ListRecordsResult): string[] {
  return page.records.map((record) => record.id);
}

async function walk(
  store: Store,
  stored: CollectionState,
  input: Partial<ListRecordsInput>,
  onPage?: (page: ListRecordsResult, index: number) => Promise<void> | void,
): Promise<RecordEnvelope[]> {
  const seen: RecordEnvelope[] = [];
  const sort = input.sort ?? { field: "id", direction: "asc" };
  let after: ListPosition | undefined;

  for (let index = 0; index < 100; index += 1) {
    const page = await list(store, stored, {
      ...input,
      sort,
      ...(after !== undefined ? { after } : {}),
    });

    if (onPage) {
      await onPage(page, index);
    }

    seen.push(...page.records);

    if (!page.hasMore) {
      return seen;
    }

    const last = page.records[page.records.length - 1];

    if (!last) {
      throw new Error("hasMore was true for an empty page.");
    }

    after = position(last, sort);
  }

  throw new Error("list walk did not finish.");
}
