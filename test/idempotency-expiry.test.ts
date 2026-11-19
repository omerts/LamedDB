import { afterEach, describe, expect, it } from "vitest";

import {
  CollectionService,
  LamedDB,
  MemoryStore,
  listen,
  type MemoryStoreOptions,
  type RunningServer,
} from "../src/index.js";
import { LIMITS, idempotencyRetentionFromEnv } from "../src/validate.js";

const TTL_MS = 1_000;

describe("idempotency key expiry", () => {
  const running: RunningServer[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close()));
  });

  it("replays the original response just before expiry and does not write", async () => {
    const clock = useClock(0);
    const { db, record } = await open(running, { now: clock.now, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const first = await putJson(record("orders", "ord_123"), { status: "paid" }, {
      "idempotency-key": "ord-paid",
    });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "paid" },
    });

    const replaced = await putJson(record("orders", "ord_123"), { status: "refunded" });

    expect(replaced.status).toBe(200);

    clock.at(TTL_MS - 1);

    const replay = await putJson(record("orders", "ord_123"), { status: "paid" }, {
      "idempotency-key": "ord-paid",
    });

    expect(replay.status).toBe(201);
    expect(replay.etag).toBe('"1"');
    expect(replay.body).toEqual(first.body);
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(replaced.body);
  });

  it("processes an expired key again, including a different body, and does not extend the TTL on replay", async () => {
    const clock = useClock(0);
    const { db, record } = await open(running, { now: clock.now, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = record("orders", "ord_123");
    const first = await putJson(url, { status: "open" }, { "idempotency-key": "ord-open" });

    clock.at(500);

    const midway = await putJson(url, { status: "open" }, { "idempotency-key": "ord-open" });

    expect(midway.status).toBe(201);
    expect(midway.body).toEqual(first.body);

    clock.at(TTL_MS - 1);

    const justBefore = await putJson(url, { status: "paid" }, { "idempotency-key": "ord-open" });

    expect(justBefore.status).toBe(409);
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(first.body);

    clock.at(TTL_MS);

    const expired = await putJson(url, { status: "paid" }, { "idempotency-key": "ord-open" });

    expect(expired.status).toBe(200);
    expect(expired.body).toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(expired.body);
  });

  it("uses the default 24 hour TTL when none is configured", async () => {
    expect(LIMITS.idempotencyTtlMs).toBe(24 * 60 * 60 * 1000);

    const clock = useClock(0);
    const { db, record } = await open(running, { now: clock.now });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = record("orders", "ord_123");
    const first = await putJson(url, { status: "paid" }, { "idempotency-key": "day" });

    clock.at(LIMITS.idempotencyTtlMs - 1);

    const replay = await putJson(url, { status: "paid" }, { "idempotency-key": "day" });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);

    clock.at(LIMITS.idempotencyTtlMs);

    const expired = await putJson(url, { status: "paid" }, { "idempotency-key": "day" });

    expect(expired.status).toBe(200);
    expect(expired.body).toMatchObject({ version: 2, data: { status: "paid" } });
  });

  it("leaves the record unchanged when an expired key fails its precondition", async () => {
    const clock = useClock(0);
    const { db, record } = await open(running, { now: clock.now, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "open" }, { idempotencyKey: "retry" });

    clock.at(TTL_MS);

    const rejected = await putJson(
      record("orders", "ord_123"),
      { status: "paid" },
      { "idempotency-key": "retry", "if-none-match": "*" },
    );

    expect(rejected.status).toBe(412);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "precondition_failed" },
    });
    await expect(orders.get("ord_123")).resolves.toEqual(created);

    const corrected = await orders.put("ord_123", { status: "paid" }, { idempotencyKey: "retry" });

    expect(corrected).toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });
  });

  it("writes an expired key once when concurrent retries arrive together", async () => {
    const clock = useClock(0);
    const { db, record } = await open(running, { now: clock.now, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = record("orders", "ord_123");

    await putJson(url, { status: "open" }, { "idempotency-key": "again" });

    clock.at(TTL_MS);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => putJson(url, { status: "paid" }, { "idempotency-key": "again" })),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: "ord_123",
        version: 2,
        data: { status: "paid" },
      });
    }

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(responses[0]?.body);
  });

  it("returns 500 when the clock is unusable and does not write", async () => {
    const { db, record } = await open(running, { now: () => Number.NaN, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const response = await putJson(record("orders", "ord_123"), { status: "paid" }, {
      "idempotency-key": "bad-clock",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal",
        message: "Clock must return a non-negative safe integer timestamp in milliseconds.",
      },
    });
    await expect(db.collection("orders").get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("keeps a key live when the clock moves backwards", async () => {
    const clock = useClock(1_000);
    const { db, record } = await open(running, { now: clock.now, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = record("orders", "ord_123");
    const first = await putJson(url, { status: "paid" }, { "idempotency-key": "back" });

    clock.at(0);

    const replay = await putJson(url, { status: "paid" }, { "idempotency-key": "back" });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });
});

describe("idempotency key cap", () => {
  const running: RunningServer[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close()));
  });

  it("drops the oldest key in that collection and processes it again", async () => {
    const { db } = await open(running, { now: () => 0, maxIdempotencyKeys: 2, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.admin.createCollection("tickets", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const first = await orders.put("a", { status: "open" }, { idempotencyKey: "key-a" });
    const second = await orders.put("b", { status: "open" }, { idempotencyKey: "key-b" });
    const ticket = await db.collection("tickets").put("a", { status: "open" }, { idempotencyKey: "key-a" });

    await orders.put("c", { status: "open" }, { idempotencyKey: "key-c" });

    const kept = await orders.put("b", { status: "open" }, { idempotencyKey: "key-b" });
    const newest = await orders.put("c", { status: "open" }, { idempotencyKey: "key-c" });
    const evicted = await orders.put("a", { status: "open" }, { idempotencyKey: "key-a" });
    const otherCollection = await db
      .collection("tickets")
      .put("a", { status: "open" }, { idempotencyKey: "key-a" });

    expect(kept).toEqual(second);
    expect(newest.version).toBe(1);
    expect(evicted.version).toBe(2);
    expect(otherCollection).toEqual(ticket);
    expect(first.version).toBe(1);
  });

  it("does not refresh the oldest key when it is replayed", async () => {
    const { db } = await open(running, { now: () => 0, maxIdempotencyKeys: 2, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");

    await orders.put("a", { status: "open" }, { idempotencyKey: "key-a" });
    await orders.put("b", { status: "open" }, { idempotencyKey: "key-b" });
    await orders.put("a", { status: "open" }, { idempotencyKey: "key-a" });
    await orders.put("c", { status: "open" }, { idempotencyKey: "key-c" });

    const stillThere = await orders.put("b", { status: "open" }, { idempotencyKey: "key-b" });
    const evicted = await orders.put("a", { status: "paid" }, { idempotencyKey: "key-a" });

    expect(stillThere).toEqual({ id: "b", version: 1, data: { status: "open" } });
    expect(evicted).toEqual({ id: "a", version: 2, data: { status: "paid" } });
  });

  it("does not evict a live key when the new put fails or conflicts", async () => {
    const { db, record } = await open(running, {
      now: () => 0,
      maxIdempotencyKeys: 1,
      idempotencyTtlMs: TTL_MS,
    });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "open" }, { idempotencyKey: "kept" });
    const conflict = await putJson(record("orders", "ord_123"), { status: "paid" }, {
      "idempotency-key": "kept",
    });

    expect(conflict.status).toBe(409);
    await expect(orders.get("ord_123")).resolves.toEqual(created);

    const rejected = await putJson(
      record("orders", "ord_123"),
      { status: "paid" },
      { "idempotency-key": "fresh", "if-none-match": "*" },
    );

    expect(rejected.status).toBe(412);
    await expect(orders.get("ord_123")).resolves.toEqual(created);

    const replay = await orders.put("ord_123", { status: "open" }, { idempotencyKey: "kept" });

    expect(replay).toEqual(created);
  });

  it("does not let an expired key take a slot from a live one", async () => {
    const clock = useClock(0);
    const { db } = await open(running, {
      now: clock.now,
      maxIdempotencyKeys: 2,
      idempotencyTtlMs: TTL_MS,
    });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");

    await orders.put("a", { status: "old" }, { idempotencyKey: "key-a" });

    clock.at(10);

    const live = await orders.put("b", { status: "live" }, { idempotencyKey: "key-b" });

    clock.at(TTL_MS);

    const added = await orders.put("c", { status: "new" }, { idempotencyKey: "key-c" });
    const kept = await orders.put("b", { status: "live" }, { idempotencyKey: "key-b" });
    const expired = await orders.put("a", { status: "old" }, { idempotencyKey: "key-a" });

    expect(kept).toEqual(live);
    expect(added.version).toBe(1);
    expect(expired.version).toBe(2);
  });

  it("keeps at most the default number of keys per collection", async () => {
    expect(LIMITS.maxIdempotencyKeysPerCollection).toBe(10_000);

    const service = new CollectionService(new MemoryStore({ now: () => 0 }));
    const cap = LIMITS.maxIdempotencyKeysPerCollection;

    await service.createCollection("orders");

    for (let index = 0; index < cap; index += 1) {
      await service.putRecord("orders", `id_${index}`, { n: index }, { idempotencyKey: `key_${index}` });
    }

    const stillThere = await service.putRecord("orders", "id_0", { n: 0 }, { idempotencyKey: "key_0" });

    expect(stillThere.record.version).toBe(1);

    await service.putRecord("orders", "id_extra", { n: -1 }, { idempotencyKey: "key_extra" });

    const kept = await service.putRecord("orders", "id_1", { n: 1 }, { idempotencyKey: "key_1" });
    const evicted = await service.putRecord("orders", "id_0", { n: 0 }, { idempotencyKey: "key_0" });

    expect(kept.record.version).toBe(1);
    expect(evicted.record.version).toBe(2);
  });
});

describe("deleting a collection drops its keys", () => {
  const running: RunningServer[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close()));
  });

  it("drops keys, records, and version counters, and leaves other collections alone", async () => {
    const { db, baseUrl } = await open(running, { now: () => 0, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.admin.createCollection("tickets", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const tickets = db.collection("tickets");

    await orders.put("ord_123", { status: "open" }, { idempotencyKey: "shared" });
    await orders.put("ord_123", { status: "paid" });

    const ticket = await tickets.put("ord_123", { status: "open" }, { idempotencyKey: "shared" });
    const removed = await fetch(`${baseUrl}/v1/collections/orders`, { method: "DELETE" });

    expect(removed.status).toBe(204);
    expect(removed.headers.get("content-type")).toBeNull();
    expect(await removed.text()).toBe("");
    await expect(orders.get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "orders" does not exist.',
    });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const recreated = await orders.put("ord_123", { status: "open" }, { idempotencyKey: "shared" });

    expect(recreated).toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
    await expect(tickets.get("ord_123")).resolves.toEqual(ticket);
    await expect(
      tickets.put("ord_123", { status: "open" }, { idempotencyKey: "shared" }),
    ).resolves.toEqual(ticket);
  });

  it("returns 404 for a missing collection and does not drop another collection's key", async () => {
    const { db, baseUrl } = await open(running);

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const created = await db.collection("orders").put("ord_123", { status: "open" }, { idempotencyKey: "kept" });
    const missing = await fetch(`${baseUrl}/v1/collections/missing`, { method: "DELETE" });

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: 'Collection "missing" does not exist.',
      },
    });
    await expect(
      db.collection("orders").put("ord_123", { status: "open" }, { idempotencyKey: "kept" }),
    ).resolves.toEqual(created);
    await expect(db.admin.deleteCollection("missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });
    await expect(db.admin.deleteCollection("orders")).resolves.toBeUndefined();
    await expect(db.collection("orders").get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("rejects unsupported delete input and leaves the collection and its key in place", async () => {
    const { db, baseUrl } = await open(running, { now: () => 0, idempotencyTtlMs: TTL_MS });

    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "paid" }, { idempotencyKey: "kept" });
    const url = `${baseUrl}/v1/collections/orders`;
    const cases: { url: string; init: RequestInit; message: string }[] = [
      {
        url,
        init: { method: "DELETE", headers: { "idempotency-key": "drop" } },
        message: "Idempotency-Key is not supported yet.",
      },
      {
        url,
        init: { method: "DELETE", headers: { "if-match": '"1"' } },
        message: "If-Match is not supported yet. Conditional replaces are a follow-up.",
      },
      {
        url,
        init: { method: "DELETE", headers: { "if-none-match": "*" } },
        message: "If-None-Match is not supported yet.",
      },
      {
        url: `${url}?force=true`,
        init: { method: "DELETE" },
        message: 'Unknown query parameter "force".',
      },
      {
        url,
        init: {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        message: "Delete does not accept a request body.",
      },
      {
        url: `${baseUrl}/v1/collections/1orders`,
        init: { method: "DELETE" },
        message:
          'Collection name "1orders" is not allowed. Use a letter, then letters, digits, underscores, or hyphens, up to 63 characters.',
      },
    ];

    for (const entry of cases) {
      const response = await fetch(entry.url, entry.init);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_argument",
          message: entry.message,
        },
      });
    }

    const method = await fetch(url);

    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("DELETE");
    await expect(method.json()).resolves.toMatchObject({
      error: { code: "method_not_allowed" },
    });

    const keyedGet = await fetch(url, { headers: { "idempotency-key": "read" } });

    expect(keyedGet.status).toBe(400);
    await expect(orders.get("ord_123")).resolves.toEqual(created);
    await expect(orders.put("ord_123", { status: "paid" }, { idempotencyKey: "kept" })).resolves.toEqual(
      created,
    );
  });
});

describe("idempotency retention configuration", () => {
  it("rejects store options that are not a positive integer, a clock, or a known key", () => {
    expect(() => new MemoryStore({ idempotencyTtlMs: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "idempotencyTtlMs must be a positive integer.",
      }),
    );
    expect(() => new MemoryStore({ idempotencyTtlMs: 1.5 })).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => new MemoryStore({ maxIdempotencyKeys: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "maxIdempotencyKeys must be a positive integer.",
      }),
    );
    expect(() => new MemoryStore({ maxIdempotencyKeys: -1 })).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => new MemoryStore({ now: "now" as unknown as () => number })).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "Clock must be a function.",
      }),
    );
    expect(() => new MemoryStore({ ttl: 5 } as MemoryStoreOptions)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: 'Unknown store option "ttl".',
      }),
    );
    expect(() => new MemoryStore(null as unknown as MemoryStoreOptions)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "MemoryStore options must be an object.",
      }),
    );

    const hidden: MemoryStoreOptions = {};

    Object.defineProperty(hidden, "ttl", { value: 5, enumerable: false });

    expect(() => new MemoryStore(hidden)).toThrow(
      expect.objectContaining({
        message: 'Unknown store option "ttl".',
      }),
    );
    expect(() => new MemoryStore({ [Symbol("lane")]: true } as unknown as MemoryStoreOptions)).toThrow(
      expect.objectContaining({
        message: 'Unknown store option "lane".',
      }),
    );
  });

  it("reads the TTL and cap from the environment and falls back when they are empty", () => {
    expect(idempotencyRetentionFromEnv({})).toEqual({
      idempotencyTtlMs: LIMITS.idempotencyTtlMs,
      maxIdempotencyKeys: LIMITS.maxIdempotencyKeysPerCollection,
    });
    expect(
      idempotencyRetentionFromEnv({
        IDEMPOTENCY_TTL_MS: "",
        IDEMPOTENCY_MAX_KEYS: "",
      }),
    ).toEqual({
      idempotencyTtlMs: LIMITS.idempotencyTtlMs,
      maxIdempotencyKeys: LIMITS.maxIdempotencyKeysPerCollection,
    });
    expect(
      idempotencyRetentionFromEnv({
        IDEMPOTENCY_TTL_MS: "1500",
        IDEMPOTENCY_MAX_KEYS: "3",
      }),
    ).toEqual({
      idempotencyTtlMs: 1500,
      maxIdempotencyKeys: 3,
    });
    expect(() => idempotencyRetentionFromEnv({ IDEMPOTENCY_TTL_MS: "0" })).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "IDEMPOTENCY_TTL_MS must be a positive integer.",
      }),
    );
    expect(() => idempotencyRetentionFromEnv({ IDEMPOTENCY_MAX_KEYS: "1.5" })).toThrow(
      expect.objectContaining({
        message: "IDEMPOTENCY_MAX_KEYS must be a positive integer.",
      }),
    );
    expect(() => idempotencyRetentionFromEnv({ IDEMPOTENCY_TTL_MS: " 1000" })).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => idempotencyRetentionFromEnv({ IDEMPOTENCY_TTL_MS: "01" })).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => idempotencyRetentionFromEnv({ IDEMPOTENCY_MAX_KEYS: "9007199254740993" })).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => idempotencyRetentionFromEnv(null as unknown as Record<string, unknown>)).toThrow(
      expect.objectContaining({
        message: "Environment must be an object.",
      }),
    );
  });

  it("applies an environment TTL and cap to the store", async () => {
    const clock = useClock(0);
    const retention = idempotencyRetentionFromEnv({
      IDEMPOTENCY_TTL_MS: "1000",
      IDEMPOTENCY_MAX_KEYS: "1",
    });
    const service = new CollectionService(new MemoryStore({ ...retention, now: clock.now }));

    await service.createCollection("orders", { fields: { status: "string" } });
    await service.putRecord("orders", "a", { status: "open" }, { idempotencyKey: "key-a" });
    await service.putRecord("orders", "b", { status: "open" }, { idempotencyKey: "key-b" });

    clock.at(999);

    const replay = await service.putRecord("orders", "b", { status: "open" }, { idempotencyKey: "key-b" });

    expect(replay.record.version).toBe(1);

    const evicted = await service.putRecord("orders", "a", { status: "open" }, { idempotencyKey: "key-a" });

    expect(evicted.record.version).toBe(2);

    clock.at(999 + 1_000 - 1);

    const stillLive = await service.putRecord("orders", "a", { status: "open" }, { idempotencyKey: "key-a" });

    expect(stillLive.record).toEqual(evicted.record);

    clock.at(999 + 1_000);

    const expired = await service.putRecord("orders", "a", { status: "paid" }, { idempotencyKey: "key-a" });

    expect(expired.record).toEqual({
      id: "a",
      version: 3,
      data: { status: "paid" },
    });
  });
});

interface OpenServer {
  db: LamedDB;
  baseUrl: string;
  record(collection: string, id: string): string;
}

function useClock(start: number): { now: () => number; at: (value: number) => void } {
  let current = start;

  return {
    now: () => current,
    at: (value: number) => {
      current = value;
    },
  };
}

async function open(running: RunningServer[], options: MemoryStoreOptions = {}): Promise<OpenServer> {
  const server = await listen({ store: new MemoryStore(options) });

  running.push(server);

  return {
    db: new LamedDB({ baseUrl: server.url }),
    baseUrl: server.url,
    record: (collection: string, id: string) =>
      `${server.url}/v1/collections/${collection}/records/${id}`,
  };
}

async function putJson(
  url: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; etag: string | null; body: unknown; json: () => Promise<unknown> }> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(data),
  });
  const body: unknown = await response.json();

  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body,
    json: () => Promise.resolve(body),
  };
}
