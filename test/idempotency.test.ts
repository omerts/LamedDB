import { connect } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LamedDB, listen, type PutOptions, type RunningServer } from "../src/index.js";
import { LIMITS, parseIdempotencyKey, parsePutOptions } from "../src/validate.js";

describe("idempotency keys", () => {
  let running: RunningServer | undefined;
  let db: LamedDB;

  beforeEach(async () => {
    running = await listen();
    db = new LamedDB({ baseUrl: running.url });
  });

  afterEach(async () => {
    await running?.close();
  });

  it("replays the original status and body and does not increase the version", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = recordUrl("orders", "ord_123");
    const first = await putJson(url, { status: "paid", note: "a" }, { "idempotency-key": "ord-123-paid" });
    const second = await putJson(
      url,
      { note: "a", status: "paid" },
      { "idempotency-key": "ord-123-paid" },
    );

    expect(first.status).toBe(201);
    expect(first.etag).toBe('"1"');
    expect(second.status).toBe(201);
    expect(second.etag).toBe('"1"');
    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "paid", note: "a" },
    });

    const replaced = await putJson(url, { status: "refunded" });

    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ version: 2, data: { status: "refunded" } });

    const replay = await putJson(url, { status: "paid", note: "a" }, { "idempotency-key": "ord-123-paid" });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(replaced.body);
  });

  it("replays a replace and a createOnly put without writing again", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });

    const url = recordUrl("orders", "ord_123");
    const replaced = await putJson(
      url,
      { status: "paid" },
      { "idempotency-key": "replace-paid", "if-none-match": "*" },
    );

    expect(replaced.status).toBe(412);

    const written = await putJson(url, { status: "paid" }, { "idempotency-key": "replace-paid" });
    const replayed = await putJson(url, { status: "paid" }, { "idempotency-key": "replace-paid" });

    expect(written.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(written.body);
    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });

    const created = await orders.put(
      "ord_new",
      { status: "open" },
      { createOnly: true, idempotencyKey: "create-new" },
    );
    const createdAgain = await orders.put(
      "ord_new",
      { status: "open" },
      { createOnly: true, idempotencyKey: "create-new" },
    );

    expect(createdAgain).toEqual(created);
    expect(created.version).toBe(1);
  });

  it("returns 409 when the same key is reused for a different request and writes nothing", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.admin.createCollection("tickets", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" }, { idempotencyKey: "shared-key" });
    await orders.put("ord_other", { status: "held" });

    const differentBody = await putJson(
      recordUrl("orders", "ord_123"),
      { status: "paid" },
      { "idempotency-key": "shared-key" },
    );

    expect(differentBody.status).toBe(409);
    await expect(differentBody.json()).resolves.toEqual({
      error: {
        code: "idempotency_conflict",
        message: 'Idempotency key "shared-key" was already used for a different request.',
        details: { idempotencyKey: "shared-key" },
      },
    });

    const differentId = await putJson(
      recordUrl("orders", "ord_new"),
      { status: "open" },
      { "idempotency-key": "shared-key" },
    );

    expect(differentId.status).toBe(409);
    await expect(differentId.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const differentOptions = await putJson(
      recordUrl("orders", "ord_123"),
      { status: "open" },
      { "idempotency-key": "shared-key", "if-none-match": "*" },
    );

    expect(differentOptions.status).toBe(409);

    const otherCollection = await putJson(
      recordUrl("tickets", "ord_123"),
      { status: "open" },
      { "idempotency-key": "shared-key" },
    );

    expect(otherCollection.status).toBe(201);

    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
    await expect(orders.get("ord_new")).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(orders.get("ord_other")).resolves.toEqual({
      id: "ord_other",
      version: 1,
      data: { status: "held" },
    });
    await expect(db.collection("tickets").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("rejects keys that are not 1-255 printable ASCII characters and does not write", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = recordUrl("orders", "ord_123");
    const tooLong = await putJson(url, { status: "paid" }, { "idempotency-key": "k".repeat(256) });

    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key must be 1-255 printable ASCII characters.",
      },
    });

    const nonAscii = await putJson(url, { status: "paid" }, { "idempotency-key": "caf\u00e9" });

    expect(nonAscii.status).toBe(400);
    await expect(nonAscii.json()).resolves.toMatchObject({
      error: { code: "invalid_argument" },
    });

    const empty = await sendRaw(
      [
        "PUT /v1/collections/orders/records/ord_123 HTTP/1.1",
        "host: 127.0.0.1",
        "content-type: application/json",
        "content-length: 17",
        "idempotency-key:",
        "connection: close",
        "",
        '{"status":"paid"}',
      ].join("\r\n"),
    );

    expect(empty.status).toBe(400);
    expect(empty.json).toMatchObject({
      error: { code: "invalid_argument" },
    });

    const duplicate = await sendRaw(
      [
        "PUT /v1/collections/orders/records/ord_123 HTTP/1.1",
        "host: 127.0.0.1",
        "content-type: application/json",
        "content-length: 17",
        "idempotency-key: one",
        "idempotency-key: two",
        "connection: close",
        "",
        '{"status":"paid"}',
      ].join("\r\n"),
    );

    expect(duplicate.status).toBe(400);
    expect(duplicate.json).toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key must be a single header value.",
      },
    });

    const maxLength = await putJson(url, { status: "paid" }, { "idempotency-key": "k".repeat(255) });

    expect(maxLength.status).toBe(201);
    await expect(db.collection("orders").get("ord_123")).resolves.toMatchObject({ version: 1 });
  });

  it("does not cache a failed put, so a corrected retry with the same key can succeed", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string", totalCents: "integer" } });

    const orders = db.collection("orders");
    const url = recordUrl("orders", "ord_123");
    const invalid = await putJson(
      url,
      { status: "paid", totalCents: 12.5 },
      { "idempotency-key": "correct-me" },
    );

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_argument" },
    });
    await expect(orders.get("ord_123")).rejects.toMatchObject({ code: "not_found" });

    const corrected = await putJson(
      url,
      { status: "paid", totalCents: 12900 },
      { "idempotency-key": "correct-me" },
    );

    expect(corrected.status).toBe(201);
    expect(corrected.body).toMatchObject({ version: 1, data: { totalCents: 12900 } });

    await orders.put("ord_existing", { status: "open", totalCents: 1 });

    const precondition = await putJson(
      recordUrl("orders", "ord_existing"),
      { status: "paid", totalCents: 2 },
      { "idempotency-key": "create-existing", "if-none-match": "*" },
    );

    expect(precondition.status).toBe(412);
    await expect(orders.get("ord_existing")).resolves.toEqual({
      id: "ord_existing",
      version: 1,
      data: { status: "open", totalCents: 1 },
    });

    const withoutCreateOnly = await putJson(
      recordUrl("orders", "ord_existing"),
      { status: "paid", totalCents: 2 },
      { "idempotency-key": "create-existing" },
    );

    expect(withoutCreateOnly.status).toBe(200);
    await expect(orders.get("ord_existing")).resolves.toEqual({
      id: "ord_existing",
      version: 2,
      data: { status: "paid", totalCents: 2 },
    });

    const missing = await putJson(
      `${running?.url}/v1/collections/missing/records/ord_123`,
      { status: "paid" },
      { "idempotency-key": "after-create" },
    );

    expect(missing.status).toBe(404);
    await db.admin.createCollection("missing", { fields: { status: "string" } });

    const afterCreate = await putJson(
      `${running?.url}/v1/collections/missing/records/ord_123`,
      { status: "paid" },
      { "idempotency-key": "after-create" },
    );

    expect(afterCreate.status).toBe(201);
  });

  it("writes once when concurrent puts share an idempotency key", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = recordUrl("orders", "ord_123");
    const body = JSON.stringify({ status: "paid" });
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "concurrent-paid",
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(url, { method: "PUT", headers, body })),
    );
    const payloads = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        etag: response.headers.get("etag"),
        body: await response.json(),
      })),
    );

    for (const payload of payloads) {
      expect(payload.status).toBe(201);
      expect(payload.etag).toBe('"1"');
      expect(payload.body).toEqual({
        id: "ord_123",
        version: 1,
        data: { status: "paid" },
      });
    }

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "paid" },
    });
  });

  it("lets one of two conflicting concurrent puts win", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const url = recordUrl("orders", "ord_123");
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "race",
    };
    const [left, right] = await Promise.all([
      fetch(url, { method: "PUT", headers, body: JSON.stringify({ status: "paid" }) }),
      fetch(url, { method: "PUT", headers, body: JSON.stringify({ status: "open" }) }),
    ]);
    const results = [
      { status: left.status, body: await left.json() },
      { status: right.status, body: await right.json() },
    ];
    const winner = results.find((result) => result.status === 201);
    const loser = results.find((result) => result.status === 409);

    expect(winner?.body).toMatchObject({ version: 1 });
    expect(loser?.body).toMatchObject({ error: { code: "idempotency_conflict" } });
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual(winner?.body);
  });

  it("keeps the original result after delete and does not recreate the record", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "paid" }, { idempotencyKey: "kept" });

    await orders.delete("ord_123");

    const replay = await putJson(recordUrl("orders", "ord_123"), { status: "paid" }, { "idempotency-key": "kept" });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(created);
    await expect(orders.get("ord_123")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("rejects Idempotency-Key on collection create and delete", async () => {
    const create = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-orders",
      },
      body: JSON.stringify({ name: "orders" }),
    });

    expect(create.status).toBe(400);
    await expect(create.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key is not supported yet.",
      },
    });

    const collectionDelete = await fetch(`${running?.url}/v1/collections`, {
      method: "DELETE",
      headers: { "idempotency-key": "create-orders" },
    });

    expect(collectionDelete.status).toBe(400);
    await expect(collectionDelete.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key is not supported yet.",
      },
    });

    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });

    const remove = await fetch(recordUrl("orders", "ord_123"), {
      method: "DELETE",
      headers: { "idempotency-key": "delete-ord-123" },
    });

    expect(remove.status).toBe(400);
    await expect(remove.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key is not supported yet.",
      },
    });

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("replays a put that sent both If-Match and Idempotency-Key after the version moves", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });

    const url = recordUrl("orders", "ord_123");
    const first = await putJson(
      url,
      { status: "paid" },
      { "if-match": '"1"', "idempotency-key": "match-and-key" },
    );

    expect(first.status).toBe(200);
    expect(first.etag).toBe('"2"');
    expect(first.body).toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });

    const moved = await orders.put("ord_123", { status: "later" });

    expect(moved.version).toBe(3);

    const replay = await putJson(
      url,
      { status: "paid" },
      { "if-match": '"1"', "idempotency-key": "match-and-key" },
    );

    expect(replay.status).toBe(200);
    expect(replay.etag).toBe('"2"');
    expect(replay.body).toEqual(first.body);

    const differentVersion = await putJson(
      url,
      { status: "paid" },
      { "if-match": '"3"', "idempotency-key": "match-and-key" },
    );

    expect(differentVersion.status).toBe(409);
    await expect(differentVersion.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 3,
      data: { status: "later" },
    });
  });

  it("rejects an idempotency query parameter and other unsupported input before writing", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });

    const byQuery = await putJson(
      `${recordUrl("orders", "ord_123")}?idempotencyKey=hidden`,
      { status: "paid" },
    );

    expect(byQuery.status).toBe(400);
    await expect(byQuery.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'Unknown query parameter "idempotencyKey".',
      },
    });

    const getByQuery = await fetch(`${recordUrl("orders", "ord_123")}?ifVersion=1`);

    expect(getByQuery.status).toBe(400);
    await expect(getByQuery.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'Unknown query parameter "ifVersion".',
      },
    });

    const getWithMatch = await fetch(recordUrl("orders", "ord_123"), {
      headers: { "if-match": '"1"' },
    });

    expect(getWithMatch.status).toBe(400);
    await expect(getWithMatch.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "If-Match is not supported yet. Conditional replaces are a follow-up.",
      },
    });

    const getWithKey = await fetch(recordUrl("orders", "ord_123"), {
      headers: { "idempotency-key": "read" },
    });

    expect(getWithKey.status).toBe(400);
    await expect(getWithKey.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key is not supported yet.",
      },
    });

    const getWithBody = await sendRaw(
      [
        "GET /v1/collections/orders/records/ord_123 HTTP/1.1",
        "host: 127.0.0.1",
        "content-type: application/json",
        "content-length: 2",
        "connection: close",
        "",
        "{}",
      ].join("\r\n"),
    );

    expect(getWithBody.status).toBe(400);
    expect(getWithBody.json).toMatchObject({
      error: {
        code: "invalid_argument",
        message: "GET does not accept a request body.",
      },
    });

    const createWithPrecondition = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
      },
      body: JSON.stringify({ name: "tickets" }),
    });

    expect(createWithPrecondition.status).toBe(400);
    await expect(createWithPrecondition.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "If-None-Match is not supported yet.",
      },
    });

    const createWithQuery = await fetch(`${running?.url}/v1/collections?layout=row`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets" }),
    });

    expect(createWithQuery.status).toBe(400);
    await expect(createWithQuery.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'Unknown query parameter "layout".',
      },
    });

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
    await expect(db.collection("tickets").get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      message: 'Collection "tickets" does not exist.',
    });
  });

  it("rejects unknown or invalid SDK put options before the request is sent", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");

    await expect(
      orders.put("ord_123", { status: "paid" }, { ttl: 5 } as PutOptions),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: 'Unknown put option "ttl".',
    });
    await expect(
      orders.put("ord_123", { status: "paid" }, { idempotencyKey: 12 } as unknown as PutOptions),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "Idempotency-Key must be a string.",
    });
    await expect(
      orders.put("ord_123", { status: "paid" }, { createOnly: "yes" } as unknown as PutOptions),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: 'Option "createOnly" must be a boolean.',
    });
    await expect(orders.get("ord_123")).rejects.toMatchObject({ code: "not_found" });
  });

  function recordUrl(collection: string, id: string): string {
    return `${running?.url}/v1/collections/${collection}/records/${id}`;
  }

  async function putJson(
    url: string,
    data: unknown,
    headers: Record<string, string> = {},
  ): Promise<PutResponse> {
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

  function sendRaw(raw: string): Promise<{ status: number; json: unknown }> {
    const port = running?.port;

    if (port === undefined) {
      throw new Error("Server is not listening.");
    }

    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(raw);
      });
      const chunks: Buffer[] = [];

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.on("error", reject);
      socket.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const separator = text.indexOf("\r\n\r\n");
        const head = separator === -1 ? text : text.slice(0, separator);
        const body = separator === -1 ? "" : text.slice(separator + 4);
        const statusLine = head.split("\r\n")[0] ?? "";
        const status = Number(statusLine.split(" ")[1]);

        resolve({
          status,
          json: body.length === 0 ? undefined : JSON.parse(body),
        });
      });
    });
  }
});

interface PutResponse {
  status: number;
  etag: string | null;
  body: unknown;
  json: () => Promise<unknown>;
}

describe("parseIdempotencyKey", () => {
  it("rejects non-strings, control characters, and the wrong length", () => {
    expect(() => parseIdempotencyKey(12)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "Idempotency-Key must be a string.",
        details: { parameter: "idempotencyKey" },
      }),
    );
    expect(() => parseIdempotencyKey("")).toThrow(
      expect.objectContaining({
        message: "Idempotency-Key must be 1-255 printable ASCII characters.",
      }),
    );
    expect(() => parseIdempotencyKey("a\nb")).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => parseIdempotencyKey("a\u007Fb")).toThrow(
      expect.objectContaining({ code: "invalid_argument", status: 400 }),
    );
    expect(() => parseIdempotencyKey("k".repeat(LIMITS.maxIdempotencyKeyLength + 1))).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    );
    expect(parseIdempotencyKey("k".repeat(LIMITS.maxIdempotencyKeyLength))).toHaveLength(255);
    expect(parseIdempotencyKey(" ")).toBe(" ");
    expect(parsePutOptions({ createOnly: false, idempotencyKey: "abc" })).toEqual({
      createOnly: false,
      idempotencyKey: "abc",
    });
    expect(parsePutOptions(undefined)).toEqual({ createOnly: false });
  });
});
