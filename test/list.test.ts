import { request as httpRequest } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionService, LamedDB, LamedError, MemoryStore, type FieldType, type ListOptions, type RunningServer } from "../src/index.js";
import { LIMITS } from "../src/validate.js";
import { startTestServer, TEST_API_KEY, type TestServer } from "./helpers.js";

const BASE = "/v1/collections/orders/records";
const day = (n: number): string => new Date(Date.UTC(2026, 10, n, 8)).toISOString();

interface Page {
  records: { id: string; version: number; data: Record<string, unknown> }[];
  nextCursor: string | null;
}

describe("list records", () => {
  let started: TestServer;
  let running: RunningServer;
  let db: LamedDB;
  let fetch: typeof globalThis.fetch;
  let url: string;

  beforeEach(async () => {
    started = await startTestServer();
    running = started.server;
    db = started.db;
    fetch = started.fetch;
    url = running.url;
    await db.admin.createCollection("orders", {
      fields: { status: "string", totalCents: "integer", createdAt: "timestamp" },
      aliases: { amount: "totalCents", state: "status" },
    });
  });

  afterEach(async () => {
    await running.close();
  });

  async function seed(count: number): Promise<void> {
    const orders = db.collection("orders");

    for (let index = 1; index <= count; index += 1) {
      await orders.put(`ord_${String(index).padStart(3, "0")}`, {
        status: index % 2 === 0 ? "paid" : "open",
        totalCents: index * 100,
        createdAt: day(index),
      });
    }
  }

  async function get(query: string, path = BASE): Promise<{ status: number; body: any }> {
    const response = await fetch(`${url}${path}${query}`);

    return { status: response.status, body: await response.json() };
  }

  async function walk(query: string, onPage?: (page: Page, index: number) => Promise<void>): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let index = 0;

    do {
      const suffix: string = cursor === null ? query : `${query}${query.includes("?") ? "&" : "?"}cursor=${cursor}`;
      const response = await get(suffix);

      expect(response.status).toBe(200);
      const page = response.body as Page;
      ids.push(...page.records.map((record) => record.id));
      await onPage?.(page, index);
      index += 1;
      cursor = page.nextCursor;
    } while (cursor !== null);

    return ids;
  }

  const allIds = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `ord_${String(index + 1).padStart(3, "0")}`);

  describe("paging", () => {
    it("returns an empty page for an empty collection", async () => {
      expect(await get("")).toEqual({ status: 200, body: { records: [], nextCursor: null } });
    });

    it("returns records in ascending id order with the default limit", async () => {
      await seed(LIMITS.defaultListLimit + 3);
      const { body } = await get("");

      expect(body.records).toHaveLength(LIMITS.defaultListLimit);
      expect(body.records[0]).toEqual({
        id: "ord_001",
        version: 1,
        data: { status: "open", totalCents: 100, createdAt: day(1) },
      });
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it("walks every record exactly once for several limits", async () => {
      await seed(23);

      for (const limit of [1, 2, 5, 22, 23, 24, 100]) {
        expect(await walk(`?limit=${limit}`)).toEqual(allIds(23));
      }
    });

    it("has a null cursor only on the last page, and no empty page in between", async () => {
      await seed(6);
      const pages: Page[] = [];

      await walk("?limit=3", async (page) => {
        pages.push(page);
      });

      expect(pages.map((page) => page.records.length)).toEqual([3, 3]);
      expect(pages.map((page) => page.nextCursor === null)).toEqual([false, true]);
    });

    it("accepts the limit bounds and rejects everything else", async () => {
      await seed(2);

      expect((await get("?limit=1")).body.records).toHaveLength(1);
      expect((await get(`?limit=${LIMITS.maxListLimit}`)).status).toBe(200);

      for (const bad of ["0", "-1", "abc", "", "1.5", "1e1", `${LIMITS.maxListLimit + 1}`, "99999999999", " 1", "1&limit=2"]) {
        const response = await get(`?limit=${bad}`);

        expect(response.status, `limit=${bad}`).toBe(400);
        expect(response.body.error.code).toBe("invalid_argument");
      }
    });

    it("does not skip or repeat when a record is deleted mid-walk, whichever record it is", async () => {
      await seed(12);
      const orders = db.collection("orders");

      const seen = await walk("?limit=3", async (_page, index) => {
        if (index === 0) {
          await orders.delete("ord_002"); // already returned
          await orders.delete("ord_004"); // the next page starts here
          await orders.delete("ord_003"); // the cursor record itself
        }
      });

      expect(seen).toEqual(allIds(12).filter((id) => id !== "ord_004"));
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("returns a record added after the position and not one added before it", async () => {
      await seed(6);
      const orders = db.collection("orders");

      const seen = await walk("?limit=2", async (_page, index) => {
        if (index === 0) {
          await orders.put("ord_0035", { status: "open" }); // sorts after the cursor (ord_002)
          await orders.put("ord_000", { status: "open" }); // sorts before it
        }
      });

      expect(seen).toContain("ord_0035");
      expect(seen).not.toContain("ord_000");
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("returns a record replaced mid-walk once, with its current version", async () => {
      await seed(6);
      const orders = db.collection("orders");
      const versions = new Map<string, number>();

      await walk("?limit=2", async (page, index) => {
        for (const record of page.records) {
          versions.set(record.id, record.version);
        }

        if (index === 0) {
          await orders.put("ord_005", { status: "refunded", totalCents: 1, createdAt: day(5) });
        }
      });

      expect(versions.get("ord_005")).toBe(2);
      expect(versions.size).toBe(6);
    });
  });

  describe("cursor", () => {
    it("rejects malformed, empty, repeated, and over-long cursors", async () => {
      await seed(3);
      const real = (await get("?limit=1")).body.nextCursor as string;
      const bad = [
        "",
        "not a cursor",
        "!!!",
        "e30", // {}
        Buffer.from('{"v":2}').toString("base64url"),
        Buffer.from("[1]").toString("base64url"),
        Buffer.from('{"v":1,"c":"orders","r":1,"q":"x","a":"bad id!"}').toString("base64url"),
        "a".repeat(LIMITS.maxCursorLength + 1),
      ];

      for (const cursor of bad) {
        const response = await get(`?cursor=${encodeURIComponent(cursor)}`);

        expect(response.status, cursor).toBe(400);
        expect(response.body.error.message).toContain("cursor");
      }

      const twice = await get(`?cursor=${real}&cursor=${real}`);

      expect(twice.status).toBe(400);
      expect(twice.body.error.message).toContain("once");
    });

    it("rejects a cursor from another collection", async () => {
      await seed(3);
      await db.admin.createCollection("tickets", { fields: { status: "string" } });
      await db.collection("tickets").put("t1", { status: "open" });
      await db.collection("tickets").put("t2", { status: "open" });
      const cursor = (await get("?limit=1")).body.nextCursor as string;
      const response = await get(`?cursor=${cursor}`, "/v1/collections/tickets/records");

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe("cursor was created for a different collection.");
    });

    it("rejects a cursor from a collection that was deleted and created again", async () => {
      await seed(3);
      const cursor = (await get("?limit=1")).body.nextCursor as string;

      await db.admin.deleteCollection("orders");
      await db.admin.createCollection("orders", { fields: { status: "string", totalCents: "integer" } });
      await db.collection("orders").put("ord_001", { status: "open" });

      const response = await get(`?cursor=${cursor}`);

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe("cursor was created for a different collection.");
    });

    it("rejects a cursor used with different filters or sort, and accepts the same ones in any order", async () => {
      await seed(8);
      const base = "?limit=1&filter[status]=paid&filter[totalCents][gte]=200";
      const cursor = (await get(base)).body.nextCursor as string;

      for (const query of [
        `?cursor=${cursor}`,
        `?cursor=${cursor}&filter[status]=open&filter[totalCents][gte]=200`,
        `?cursor=${cursor}&filter[status]=paid`,
        `?cursor=${cursor}&filter[status]=paid&filter[totalCents][gte]=300`,
        `?cursor=${cursor}&filter[status]=paid&filter[totalCents][gte]=200&sort=-totalCents`,
      ]) {
        const response = await get(query);

        expect(response.status, query).toBe(400);
        expect(response.body.error.message).toContain("different filter or sort");
      }

      const same = await get(`?cursor=${cursor}&filter[totalCents][gte]=200&filter[status]=paid&limit=5`);

      expect(same.status).toBe(200);
      expect(same.body.records.map((record: { id: string }) => record.id)).toEqual(["ord_004", "ord_006", "ord_008"]);
    });

    it("rejects a sorted cursor whose sort value does not fit the field", async () => {
      await seed(3);
      const cursor = Buffer.from(
        JSON.stringify({ v: 1, c: "orders", r: 1, q: "x", a: "ord_001", s: "oops" }),
      ).toString("base64url");
      const response = await get(`?sort=totalCents&cursor=${cursor}`);

      expect(response.status).toBe(400);
    });
  });

  describe("filters", () => {
    beforeEach(async () => {
      await seed(10);
      await db.collection("orders").put("ord_011", { status: null, createdAt: null });
      await db.collection("orders").put("ord_012", { note: "no declared fields" });
    });

    const ids = async (query: string): Promise<string[]> => {
      const response = await get(query);

      expect(response.status, query).toBe(200);

      return response.body.records.map((record: { id: string }) => record.id);
    };

    it("matches equality by declared type, with and without [eq]", async () => {
      expect(await ids("?filter[status]=paid")).toEqual(["ord_002", "ord_004", "ord_006", "ord_008", "ord_010"]);
      expect(await ids("?filter[status][eq]=paid")).toEqual(await ids("?filter[status]=paid"));
      expect(await ids("?filter[totalCents]=300")).toEqual(["ord_003"]);
      expect(await ids(`?filter[createdAt]=${day(4)}`)).toEqual(["ord_004"]);
      expect(await ids("?filter[id]=ord_007")).toEqual(["ord_007"]);
    });

    it("treats null as null or missing, for eq and ne", async () => {
      expect(await ids("?filter[status]=null")).toEqual(["ord_011", "ord_012"]);
      expect(await ids("?filter[totalCents]=null")).toEqual(["ord_011", "ord_012"]);
      expect(await ids("?filter[status][ne]=null&filter[totalCents][ne]=null")).toEqual(await ids("?filter[totalCents][gte]=0"));
    });

    it("supports ne, including missing values", async () => {
      expect(await ids("?filter[status][ne]=paid")).toEqual(["ord_001", "ord_003", "ord_005", "ord_007", "ord_009", "ord_011", "ord_012"]);
      expect(await ids("?filter[status][ne]=null&filter[totalCents][lt]=300")).toEqual(["ord_001", "ord_002"]);
    });

    it("supports in, with null, and rejects an empty or oversized list", async () => {
      expect(await ids("?filter[totalCents][in]=100,300,999")).toEqual(["ord_001", "ord_003"]);
      expect(await ids("?filter[status][in]=paid,null")).toEqual(["ord_002", "ord_004", "ord_006", "ord_008", "ord_010", "ord_011", "ord_012"]);

      const tooMany = Array.from({ length: LIMITS.maxInValues + 1 }, (_, index) => index).join(",");

      for (const query of [`?filter[totalCents][in]=${tooMany}`, "?filter[totalCents][in]=1,abc", "?filter[totalCents][in]="]) {
        expect((await get(query)).status, query).toBe(400);
      }

      // An empty value is one empty string: a string field can be matched against it.
      await db.collection("orders").put("ord_013", { status: "" });
      expect(await ids("?filter[status][in]=")).toEqual(["ord_013"]);
      expect(await ids("?filter[status]=")).toEqual(["ord_013"]);
    });

    it("supports prefix on strings only, and not empty", async () => {
      expect(await ids("?filter[id][prefix]=ord_01")).toEqual(["ord_010", "ord_011", "ord_012"]);
      expect(await ids("?filter[status][prefix]=pa")).toHaveLength(5);

      const onInteger = await get("?filter[totalCents][prefix]=1");

      expect(onInteger.status).toBe(400);
      expect(onInteger.body.error.message).toContain('"prefix" only works on string fields');
      expect((await get("?filter[status][prefix]=")).status).toBe(400);
    });

    it("compares integers by number, not by text", async () => {
      expect(await ids("?filter[totalCents][gt]=900")).toEqual(["ord_010"]);
      expect(await ids("?filter[totalCents][gte]=900")).toEqual(["ord_009", "ord_010"]);
      expect(await ids("?filter[totalCents][lt]=200")).toEqual(["ord_001"]);
      expect(await ids("?filter[totalCents][lte]=200")).toEqual(["ord_001", "ord_002"]);
      expect(await ids("?filter[totalCents][gte]=-5")).toHaveLength(10);
    });

    it("compares timestamps in time order and strings in code-unit order", async () => {
      expect(await ids(`?filter[createdAt][gte]=${day(8)}`)).toEqual(["ord_008", "ord_009", "ord_010"]);
      expect(await ids("?filter[createdAt][lt]=2026-11-03T00:00:00.000Z")).toEqual(["ord_001", "ord_002"]);
      expect(await ids("?filter[id][gt]=ord_010&filter[id][lt]=ord_012")).toEqual(["ord_011"]);
      expect(await ids("?filter[status][gt]=open")).toEqual(["ord_002", "ord_004", "ord_006", "ord_008", "ord_010"]);
    });

    it("never matches a null or missing value with a range", async () => {
      const lessThanEverything = await ids("?filter[totalCents][lt]=1000000");

      expect(lessThanEverything).not.toContain("ord_011");
      expect(lessThanEverything).not.toContain("ord_012");
    });

    it("ANDs clauses and allows two operators on one field", async () => {
      expect(await ids("?filter[status]=paid&filter[totalCents][gte]=400&filter[totalCents][lt]=900")).toEqual(["ord_004", "ord_006", "ord_008"]);
      expect(await ids("?filter[status]=paid&filter[status][ne]=paid")).toEqual([]);
    });

    it("rejects a repeated field and operator, including through an alias", async () => {
      for (const query of [
        "?filter[status]=paid&filter[status][eq]=open",
        "?filter[totalCents][gte]=1&filter[totalCents][gte]=2",
        "?filter[amount][gte]=1&filter[totalCents][gte]=2",
        "?filter[state]=paid&filter[status]=paid",
      ]) {
        const response = await get(query);

        expect(response.status, query).toBe(400);
        expect(response.body.error.message).toContain("repeated");
      }
    });

    it("allows the maximum number of clauses and rejects one more", async () => {
      const ok = ["eq", "ne", "gt", "gte", "lt", "lte", "in"].map((op) => `filter[totalCents][${op}]=${op === "in" ? "100,200" : "150"}`);
      const more = ["filter[status]=paid", "filter[status][ne]=x", "filter[createdAt][gt]=" + day(1)];
      const parts = [...ok, ...more].slice(0, LIMITS.maxFilterClauses);

      expect((await get(`?${parts.join("&")}`)).status).toBe(200);

      const tooMany = await get(`?${[...parts, "filter[id][gt]=a"].join("&")}`);

      expect(tooMany.status).toBe(400);
      expect(tooMany.body.error.message).toContain(`at most ${LIMITS.maxFilterClauses}`);
    });

    it("names the bad field or operator and lists the valid ones", async () => {
      const field = await get("?filter[price]=1");

      expect(field.status).toBe(400);
      expect(field.body.error.message).toBe(
        'Cannot filter by unknown field "price". Known fields: "id", "status", "totalCents", "createdAt", "amount", "state".',
      );

      const op = await get("?filter[status][like]=a");

      expect(op.status).toBe(400);
      expect(op.body.error.message).toBe(
        'Unknown filter operator "like" on "status". Operators: eq, ne, gt, gte, lt, lte, in, prefix.',
      );
    });

    it("rejects values that do not fit the type, and range on null", async () => {
      for (const query of [
        "?filter[totalCents]=abc",
        "?filter[totalCents]=1.5",
        "?filter[totalCents]=01",
        "?filter[totalCents]=9007199254740993",
        "?filter[totalCents]=",
        "?filter[createdAt]=2026-11-19",
        "?filter[createdAt]=2026-02-31T00:00:00.000Z",
        "?filter[createdAt][gte]=yesterday",
        "?filter[totalCents][gt]=null",
        "?filter[createdAt][lte]=null",
      ]) {
        const response = await get(query);

        expect(response.status, query).toBe(400);
        expect(response.body.error.code).toBe("invalid_argument");
      }
    });

    it("rejects malformed filter keys as filters, and other parameters as unknown", async () => {
      for (const key of ["filter[]", "filter[a][b][c]", "filter[a", "filter.status", "filter", "filter[a]x", "filter[status][]", "filterx[status]"]) {
        const response = await get(`?${encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]")}=1`);

        expect(response.status, key).toBe(400);
        expect(response.body.error.message, key).toMatch(/Malformed filter|Unknown query parameter/);
      }

      const other = await get("?foo=1");

      expect(other.body.error.message).toBe('Unknown query parameter "foo".');
    });

    it("pages through a filtered result with no duplicates and no skips", async () => {
      expect(await walk("?limit=2&filter[status]=paid&filter[totalCents][gte]=400")).toEqual(["ord_004", "ord_006", "ord_008", "ord_010"]);
    });
  });

  describe("aliases", () => {
    beforeEach(seed.bind(null, 6));

    it("returns aliases on create and omits the key when there are none", async () => {
      expect(await db.admin.createCollection("plain", { fields: { a: "string" } })).toEqual({ name: "plain", fields: { a: "string" } });
      expect(await db.admin.createCollection("aliased", { fields: { a: "string" }, aliases: { b: "a" } })).toEqual({
        name: "aliased",
        fields: { a: "string" },
        aliases: { b: "a" },
      });
    });

    it("filters and sorts through an alias exactly like the real field", async () => {
      const viaAlias = await get("?filter[amount][gte]=300&sort=-amount");
      const viaField = await get("?filter[totalCents][gte]=300&sort=-totalCents");

      expect(viaAlias.status).toBe(200);
      expect(viaAlias.body).toEqual(viaField.body);
      expect(viaAlias.body.records.map((record: { id: string }) => record.id)).toEqual(["ord_006", "ord_005", "ord_004", "ord_003"]);
      expect((await get("?filter[state]=paid")).body.records).toHaveLength(3);
    });

    it("lets a cursor made through an alias be used through the real field", async () => {
      const first = await get("?filter[amount][gte]=200&sort=amount&limit=2");
      const next = await get(`?filter[totalCents][gte]=200&sort=totalCents&limit=2&cursor=${first.body.nextCursor}`);

      expect(next.status).toBe(200);
      expect(next.body.records.map((record: { id: string }) => record.id)).toEqual(["ord_004", "ord_005"]);
    });

    it("rejects a bad alias on create and creates nothing", async () => {
      const bad: [unknown, string][] = [
        [{ status: "status" }, "collides with a declared field"],
        [{ id: "status" }, 'reserved name "id"'],
        [{ ghost: "missing" }, "must point at a declared field"],
        [{ first: "status", second: "first" }, "must point at a declared field"], // an alias cannot point at another alias
        [{ "bad name": "status" }, "is not allowed"],
        [{ ok: 5 }, "must point at a declared field"],
        [["x"], 'must be an object'],
        [Object.fromEntries(Array.from({ length: LIMITS.maxAliases + 1 }, (_, i) => [`a${i}`, "status"])), "at most"],
      ];

      for (const [aliases, message] of bad) {
        const response = await fetch(`${url}/v1/collections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "broken", fields: { status: "string", amount: "integer" }, aliases }),
        });
        const body = (await response.json()) as { error: { message: string } };

        expect(response.status, message).toBe(400);
        expect(body.error.message).toContain(message);
        expect((await fetch(`${url}/v1/collections/broken/records`)).status).toBe(404);
      }
    });

    it("rejects aliases without declared fields", async () => {
      await expect(db.admin.createCollection("nofields", { aliases: { a: "b" } })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    });
  });

  describe("sort", () => {
    beforeEach(async () => {
      await seed(6);
      await db.collection("orders").put("ord_007", { status: "open", totalCents: 300 }); // ties with ord_003, no createdAt
      await db.collection("orders").put("ord_008", { status: "open" }); // no totalCents
    });

    const ids = async (query: string): Promise<string[]> => {
      const response = await get(query);

      expect(response.status, query).toBe(200);

      return response.body.records.map((record: { id: string }) => record.id);
    };

    it("sorts ascending with missing values first and id as the tiebreaker", async () => {
      expect(await ids("?sort=totalCents")).toEqual(["ord_008", "ord_001", "ord_002", "ord_003", "ord_007", "ord_004", "ord_005", "ord_006"]);
    });

    it("sorts descending with missing values last and ascending id on ties", async () => {
      expect(await ids("?sort=-totalCents")).toEqual(["ord_006", "ord_005", "ord_004", "ord_003", "ord_007", "ord_002", "ord_001", "ord_008"]);
    });

    it("sorts by id descending and by timestamp", async () => {
      expect(await ids("?sort=-id&limit=3")).toEqual(["ord_008", "ord_007", "ord_006"]);
      expect(await ids("?sort=-createdAt&limit=2")).toEqual(["ord_006", "ord_005"]);
    });

    it("walks a sorted, filtered result once, in order, for several limits", async () => {
      for (const limit of [1, 2, 3, 7]) {
        expect(await walk(`?sort=-totalCents&filter[status]=open&limit=${limit}`)).toEqual(
          ["ord_005", "ord_003", "ord_007", "ord_001", "ord_008"],
        );
        expect(await walk(`?sort=totalCents&limit=${limit}`)).toEqual(
          ["ord_008", "ord_001", "ord_002", "ord_003", "ord_007", "ord_004", "ord_005", "ord_006"],
        );
      }
    });

    it("keeps unchanged records exactly once when one is deleted mid-walk", async () => {
      const seen = await walk("?sort=totalCents&limit=2", async (_page, index) => {
        if (index === 0) {
          await db.collection("orders").delete("ord_003");
        }
      });

      expect(seen).toEqual(["ord_008", "ord_001", "ord_002", "ord_007", "ord_004", "ord_005", "ord_006"]);
    });

    it("rejects unknown, string, repeated, and empty sorts", async () => {
      for (const query of ["?sort=price", "?sort=status", "?sort=state", "?sort=-", "?sort=", "?sort=totalCents&sort=id", "?sort=--id"]) {
        expect((await get(query)).status, query).toBe(400);
      }

      expect((await get("?sort=price")).body.error.message).toContain('Cannot sort by unknown field "price"');
      expect((await get("?sort=status")).body.error.message).toContain("Cannot sort by string field");
    });
  });

  describe("errors and routing", () => {
    it("returns 404 for a missing collection and 400 for an invalid name", async () => {
      expect((await get("", "/v1/collections/ghost/records")).status).toBe(404);
      expect((await get("", "/v1/collections/bad%20name/records")).status).toBe(400);
      expect((await get("", "/v1/collections/%E0%A4%A/records")).status).toBe(400);
    });

    it("requires a key before the collection lookup and before parsing the query", async () => {
      for (const path of [BASE, "/v1/collections/ghost/records", `${BASE}?limit=abc&filter[`, `${BASE}?foo=1`]) {
        const response = await globalThis.fetch(`${url}${path}`);

        expect(response.status, path).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      }

      const wrong = await globalThis.fetch(`${url}${BASE}`, { headers: { authorization: "Bearer nope" } });

      expect(wrong.status).toBe(401);
    });

    it("rejects a missing key before any storage access or body read", async () => {
      const touched: string[] = [];
      const spy = new MemoryStore();
      const watched = new Proxy(spy, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);

          if (typeof value !== "function") {
            return value;
          }

          return (...args: unknown[]): unknown => {
            touched.push(String(property));

            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const guarded = await startTestServer({ store: watched });

      try {
        const response = await globalThis.fetch(`${guarded.server.url}${BASE}?limit=abc&filter[`);
        const body = (await response.json()) as { error: { code: string; message: string } };

        expect(response.status).toBe(401);
        expect(body.error).toEqual({ code: "unauthenticated", message: "A valid API key is required." });

        // A request that promises a body and never sends it still gets its 401 straight away.
        const early = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(
            `${guarded.server.url}${BASE}`,
            { method: "GET", headers: { "content-length": "1000" } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
              request.destroy();
            },
          );

          request.on("error", () => undefined);
          request.write("{");
        });

        expect(early).toBe(401);
        expect(touched).toEqual([]);
      } finally {
        await guarded.server.close();
      }
    });

    it("rejects a body and conditional headers on a list request", async () => {
      const variants: Record<string, string>[] = [{ "if-match": '"1"' }, { "idempotency-key": "k" }, { "if-none-match": "*" }];

      for (const headers of variants) {
        expect((await fetch(`${url}${BASE}`, { headers })).status).toBe(400);
      }

      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${url}${BASE}`,
          { method: "GET", headers: { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json", "content-length": "2" } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );

        request.on("error", reject);
        request.end("{}");
      });

      expect(status).toBe(400);
    });

    it("returns 405 with Allow for other methods and leaves data unchanged", async () => {
      await seed(2);

      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const response = await fetch(`${url}${BASE}`, { method });

        expect(response.status, method).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }

      for (const query of ["?limit=1", "?foo=bar"]) {
        const response = await fetch(`${url}${BASE}${query}`, { method: "PUT", headers: { "if-match": '"1"', "idempotency-key": "k" } });

        expect(response.status, query).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
      }

      expect((await get("")).body.records).toHaveLength(2);
    });

    it("rejects limit, cursor, sort and filter on every other route, and any unknown parameter on this one", async () => {
      await seed(1);

      for (const query of ["?limit=1", "?cursor=abc", "?sort=id", "?filter[status]=paid"]) {
        for (const path of ["/v1/collections", "/v1/collections/orders", `${BASE}/ord_001`]) {
          const response = await fetch(`${url}${path}${query}`, { method: path === "/v1/collections" ? "POST" : "GET" });

          expect(response.status, `${path}${query}`).toBe(400);
          expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/^Unknown query parameter/);
        }
      }

      expect((await get("?limit=1&extra=1")).body.error.message).toBe('Unknown query parameter "extra".');
    });

    it("keeps the other 404s for unknown paths", async () => {
      expect((await fetch(`${url}${BASE}/a/b`)).status).toBe(404);
    });
  });

  describe("SDK and service", () => {
    it("lists pages through the SDK with a filter, a sort and a cursor", async () => {
      await seed(8);
      const orders = db.collection("orders");
      const first = await orders.list({ limit: 2, sort: "-amount", filter: { status: "paid", amount: { gte: 200, lt: 800 } } });

      expect(first.records.map((record) => record.id)).toEqual(["ord_006", "ord_004"]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await orders.list({
        limit: 2,
        sort: "-amount",
        filter: { status: "paid", amount: { gte: 200, lt: 800 } },
        cursor: first.nextCursor ?? "",
      });

      expect(second).toMatchObject({ records: [{ id: "ord_002" }], nextCursor: null });
      expect((await orders.list({ filter: { totalCents: { in: [100, 300] } } })).records).toHaveLength(2);
      expect((await orders.list({ filter: { status: null } })).records).toHaveLength(0);
      expect((await orders.list()).records).toHaveLength(8);
    });

    it("rejects bad options before any request is sent", async () => {
      let calls = 0;
      const counting = new LamedDB({
        baseUrl: running.url,
        apiKey: TEST_API_KEY,
        fetch: (input, init) => {
          calls += 1;

          return globalThis.fetch(input, init);
        },
      });
      const orders = counting.collection("orders");
      const bad: unknown[] = [
        null,
        "x",
        { nope: 1 },
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { limit: "5" },
        { cursor: 5 },
        { cursor: "" },
        { sort: 5 },
        { sort: "" },
        { filter: "x" },
        { filter: [] },
        { filter: { status: true } },
        { filter: { status: {} , totalCents: { like: 1 } } },
        { filter: { totalCents: 1.5 } },
        { filter: { totalCents: { in: 5 } } },
        { filter: { totalCents: { in: [] } } },
        { filter: { status: { in: ["a,b"] } } },
        { filter: { status: { eq: undefined } } },
        { filter: { status: { prefix: null } } },
        { filter: { status: { prefix: 5 } } },
        { filter: { totalCents: { in: Array.from({ length: LIMITS.maxInValues + 1 }, (_, i) => i) } } },
        { filter: Object.fromEntries(Array.from({ length: LIMITS.maxFilterClauses + 1 }, (_, i) => [`f${i}`, "x"])) },
      ];

      for (const options of bad) {
        await expect(orders.list(options as never), JSON.stringify(options)).rejects.toMatchObject({ code: "invalid_argument" });
      }

      expect(calls).toBe(0);
    });

    it("passes server errors through as LamedError", async () => {
      const orders = db.collection("orders");

      await expect(orders.list({ filter: { nope: 1 } })).rejects.toBeInstanceOf(LamedError);
      await expect(db.collection("ghost").list()).rejects.toMatchObject({ code: "not_found" });
    });

    it("validates options in the service and keeps stores behind the interface", async () => {
      const service = new CollectionService(new MemoryStore());

      await service.createCollection("orders", { fields: { n: "integer" } });
      await service.listRecords("orders", { filter: { n: { gte: 1 } } }).then(
        () => undefined,
        () => undefined,
      );
      await expect(service.listRecords("orders", { surprise: 1 })).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(service.listRecords("orders", 5)).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(service.listRecords(5 as never)).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(service.listRecords("orders", { filter: { n: { eq: {} } } })).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(service.listRecords("orders", { limit: 3, filter: { n: "1" } })).resolves.toEqual({ records: [], nextCursor: null });
    });

    it("does not change stored data on a failed list", async () => {
      await seed(3);
      await get("?limit=0");
      await get("?filter[nope]=1");

      expect((await get("")).body.records.map((record: { version: number }) => record.version)).toEqual([1, 1, 1]);
    });
  });

  describe("review fixes", () => {
    it("reads only own properties, so fields named like Object.prototype members work", async () => {
      await db.admin.createCollection("odd", {
        fields: { constructor: "integer", toString: "string", valueOf: "integer", n: "integer" } as Record<string, FieldType>,
      });
      const odd = db.collection("odd");

      await odd.put("a", { n: 1 });
      await odd.put("b", { n: 2, constructor: 5, toString: "x" });
      await odd.put("c", { n: 3, constructor: 7 });

      const ids = async (query: string): Promise<string[]> => {
        const response = await get(query, "/v1/collections/odd/records");

        expect(response.status, query).toBe(200);

        return response.body.records.map((record: { id: string }) => record.id);
      };

      expect(await ids("?filter[constructor]=null")).toEqual(["a"]);
      expect(await ids("?filter[toString]=null")).toEqual(["a", "c"]);
      expect(await ids("?filter[valueOf]=null")).toEqual(["a", "b", "c"]);
      expect(await ids("?filter[constructor][gte]=6")).toEqual(["c"]);
      expect(await ids("?filter[toString][prefix]=x")).toEqual(["b"]);

      for (const field of ["constructor", "valueOf"]) {
        const seen: string[] = [];
        let cursor = "";

        for (let page = 0; page < 5; page += 1) {
          const response = await get(`?sort=${field}&limit=1${cursor}`, "/v1/collections/odd/records");

          expect(response.status, `${field} page ${page}`).toBe(200);
          seen.push(...response.body.records.map((record: { id: string }) => record.id));

          if (response.body.nextCursor === null) {
            break;
          }

          cursor = `&cursor=${response.body.nextCursor}`;
        }

        expect(seen, field).toEqual(["a", "b", "c"]);
      }
    });

    it("rejects an empty operator object in the SDK and the service, and sends nothing", async () => {
      let calls = 0;
      const counting = new LamedDB({
        baseUrl: running.url,
        apiKey: TEST_API_KEY,
        fetch: (input, init) => {
          calls += 1;

          return globalThis.fetch(input, init);
        },
      });

      await seed(2);
      await expect(counting.collection("orders").list({ filter: { status: {} } })).rejects.toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("has no operator"),
      });
      expect(calls).toBe(0);

      const service = new CollectionService(new MemoryStore());

      await service.createCollection("orders", { fields: { status: "string" } });
      await expect(service.listRecords("orders", { filter: { status: {} } })).rejects.toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("has no operator"),
      });
    });

    it("rejects an empty prefix and null with a range operator in the SDK before any request", async () => {
      let calls = 0;
      const counting = new LamedDB({
        baseUrl: running.url,
        apiKey: TEST_API_KEY,
        fetch: (input, init) => {
          calls += 1;

          return globalThis.fetch(input, init);
        },
      });
      const orders = counting.collection("orders");

      const bad: NonNullable<ListOptions["filter"]>[] = [
        { status: { prefix: "" } },
        { status: { prefix: null } },
        { totalCents: { gt: null } },
        { totalCents: { gte: null } },
        { createdAt: { lt: null } },
        { createdAt: { lte: null } },
      ];

      for (const filter of bad) {
        await expect(orders.list({ filter }), JSON.stringify(filter)).rejects.toMatchObject({ code: "invalid_argument" });
      }

      expect(calls).toBe(0);
      // null is still fine where the server accepts it.
      await expect(orders.list({ filter: { totalCents: { ne: null } } })).resolves.toMatchObject({ records: [] });
    });

    it("copies only the records it returns", async () => {
      await seed(30);

      const original = globalThis.structuredClone;
      let copies = 0;

      globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof structuredClone>[1]) => {
        copies += 1;

        return original(value, options);
      }) as typeof structuredClone;

      try {
        const page = await get("?limit=3&filter[totalCents][gte]=500&sort=-totalCents");

        expect(page.body.records).toHaveLength(3);
        expect(copies).toBe(3);
      } finally {
        globalThis.structuredClone = original;
      }
    });

    it("returns Unknown query parameter for names that only start with filter", async () => {
      for (const key of ["filters", "filterBy", "filtered[a]", "filterx"]) {
        const response = await get(`?${key}=1`);

        expect(response.status, key).toBe(400);
        expect(response.body.error.message, key).toBe(`Unknown query parameter "${key}".`);
      }

      for (const key of ["filter", "filter.status", "filter[status"]) {
        expect((await get(`?${key}=1`)).body.error.message, key).toMatch(/^Malformed filter/);
      }
    });

    it("runs the README paging example", async () => {
      await seed(5);

      const options = { limit: 2, sort: "-amount", filter: { status: "open", amount: { gte: 100 } } };
      const orders = db.collection("orders");
      const page = await orders.list(options);

      expect(page.records.map((record) => record.id)).toEqual(["ord_005", "ord_003"]);
      expect(page.nextCursor).not.toBeNull();

      const next = await orders.list({ ...options, cursor: page.nextCursor ?? "" });

      expect(next.records.map((record) => record.id)).toEqual(["ord_001"]);
      expect(next.nextCursor).toBeNull();
    });
  });
});
