import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LamedDB, LamedError, listen, type RunningServer } from "../src/index.js";
import { LIMITS, parseCollectionName, parseRecordId } from "../src/validate.js";

const paidAt = "2026-11-19T08:15:00.000Z";

describe("collections API", () => {
  let running: RunningServer | undefined;
  let db: LamedDB;

  beforeEach(async () => {
    running = await listen();
    db = new LamedDB({ baseUrl: running.url });
  });

  afterEach(async () => {
    await running?.close();
  });

  it("creates a collection, puts a record, and reads it back", async () => {
    const collection = await db.admin.createCollection("orders", {
      fields: {
        status: "string",
        createdAt: "timestamp",
        totalCents: "integer",
      },
    });

    expect(collection).toEqual({
      name: "orders",
      fields: {
        status: "string",
        createdAt: "timestamp",
        totalCents: "integer",
      },
    });

    const orders = db.collection("orders");
    const created = await orders.put(
      "ord_123",
      {
        status: "paid",
        totalCents: 12900,
        createdAt: paidAt,
        note: "pilot",
      },
      { createOnly: true },
    );

    expect(created).toEqual({
      id: "ord_123",
      version: 1,
      data: {
        status: "paid",
        totalCents: 12900,
        createdAt: paidAt,
        note: "pilot",
      },
    });

    await expect(orders.get("ord_123")).resolves.toEqual(created);
  });

  it("replaces the whole document and increases the version", async () => {
    await db.admin.createCollection("orders", {
      fields: { status: "string", totalCents: "integer" },
    });

    const orders = db.collection("orders");

    await orders.put("ord_123", { status: "open", totalCents: 500, note: "first" });

    const replaced = await orders.put("ord_123", { status: "paid", totalCents: 12900 });
    const again = await orders.put("ord_123", { status: "refunded", totalCents: 0 });

    expect(replaced.version).toBe(2);
    expect(again).toEqual({
      id: "ord_123",
      version: 3,
      data: { status: "refunded", totalCents: 0 },
    });
    await expect(orders.get("ord_123")).resolves.toEqual(again);
  });

  it("returns 412 when createOnly hits an existing record and leaves it unchanged", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" }, { createOnly: true });

    await expect(orders.put("ord_123", { status: "paid" }, { createOnly: true })).rejects.toMatchObject({
      name: "LamedError",
      code: "precondition_failed",
      status: 412,
      message: 'Record "ord_123" already exists in collection "orders".',
    });

    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("returns 404 for a missing record and for an unknown collection", async () => {
    await db.admin.createCollection("orders");

    await expect(db.collection("orders").get("ord_missing")).rejects.toBeInstanceOf(LamedError);
    await expect(db.collection("orders").get("ord_missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Record "ord_missing" was not found in collection "orders".',
    });

    await expect(db.collection("missing").put("ord_123", { status: "paid" })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });
    await expect(db.collection("missing").get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });
  });

  it("rejects declared field values that do not match their type and does not write", async () => {
    await db.admin.createCollection("orders", {
      fields: { status: "string", totalCents: "integer", createdAt: "timestamp" },
    });

    const orders = db.collection("orders");

    await expect(orders.put("ord_123", { status: "paid", totalCents: 12.5 })).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: 'Field "totalCents" must be an integer in the safe integer range, or null.',
      details: { field: "totalCents", expected: "integer" },
    });
    await expect(orders.put("ord_123", { status: 1, totalCents: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      details: { field: "status", expected: "string" },
    });
    await expect(orders.put("ord_123", { createdAt: "2026-11-19" })).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      details: { field: "createdAt", expected: "timestamp" },
    });

    await expect(orders.get("ord_123")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("accepts null for a declared field and stores undeclared JSON", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const record = await db.collection("orders").put("ord_123", {
      status: null,
      extra: { lane: "b", qty: 2 },
    });

    expect(record.data).toEqual({
      status: null,
      extra: { lane: "b", qty: 2 },
    });
  });

  it("rejects a duplicate collection, an invalid name, and an unsupported field type", async () => {
    await db.admin.createCollection("orders");

    await expect(db.admin.createCollection("orders")).rejects.toMatchObject({
      code: "already_exists",
      status: 409,
    });
    await expect(db.admin.createCollection("1orders")).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });

    const response = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets", fields: { status: "boolean" } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: expect.stringContaining("unsupported type"),
      },
    });

    const unknownProperty = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets", description: "nope" }),
    });

    expect(unknownProperty.status).toBe(400);

    const notAnObject = await fetch(`${running?.url}/v1/collections/orders/records/ord_1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "[]",
    });

    expect(notAnObject.status).toBe(400);
    await expect(notAnObject.json()).resolves.toMatchObject({
      error: { code: "invalid_argument", message: "Record data must be a JSON object." },
    });
  });

  it("serves create, put, and get over HTTP with createOnly on If-None-Match", async () => {
    const baseUrl = running?.url;
    const createdCollection = await fetch(`${baseUrl}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "orders",
        fields: { status: "string", totalCents: "integer", createdAt: "timestamp" },
      }),
    });

    expect(createdCollection.status).toBe(201);
    expect(createdCollection.headers.get("location")).toBe("/v1/collections/orders");

    const created = await fetch(`${baseUrl}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
      },
      body: JSON.stringify({
        status: "paid",
        totalCents: 12900,
        createdAt: paidAt,
      }),
    });

    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    await expect(created.json()).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "paid", totalCents: 12900, createdAt: paidAt },
    });

    const conflict = await fetch(`${baseUrl}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
      },
      body: JSON.stringify({ status: "paid", totalCents: 1, createdAt: paidAt }),
    });

    expect(conflict.status).toBe(412);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "precondition_failed" },
    });

    const replaced = await fetch(`${baseUrl}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "refunded", totalCents: 0, createdAt: paidAt }),
    });

    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("etag")).toBe('"2"');

    const fetched = await fetch(`${baseUrl}/v1/collections/orders/records/ord_123`);

    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "refunded", totalCents: 0, createdAt: paidAt },
    });

    const missing = await fetch(`${baseUrl}/v1/collections/orders/records/ord_missing`);

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("returns a JSON 400 when the body exceeds 1 MiB", async () => {
    const response = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "orders", note: "x".repeat(LIMITS.maxBodyBytes) }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Request body exceeds 1 MiB.",
      },
    });

    const created = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "orders" }),
    });

    expect(created.status).toBe(201);
  });

  it("rejects Idempotency-Key and If-Match on collection create before writing", async () => {
    const idempotent = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "create-orders",
      },
      body: JSON.stringify({ name: "orders" }),
    });

    expect(idempotent.status).toBe(400);
    await expect(idempotent.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Idempotency-Key is not supported yet.",
      },
    });

    const conditional = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": '"1"',
      },
      body: JSON.stringify({ name: "orders" }),
    });

    expect(conditional.status).toBe(400);
    await expect(conditional.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "If-Match is not supported yet. Conditional replaces are a follow-up.",
      },
    });

    const created = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "orders" }),
    });

    expect(created.status).toBe(201);
  });

  it("treats only a bare If-None-Match star as createOnly", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });

    const quoted = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": '"*"',
      },
      body: JSON.stringify({ status: "paid" }),
    });

    expect(quoted.status).toBe(400);
    await expect(quoted.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'If-None-Match only supports "*" in this version.',
      },
    });

    const bare = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-none-match": "*",
      },
      body: JSON.stringify({ status: "paid" }),
    });

    expect(bare.status).toBe(412);
    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("deletes a record and lets the same id start again at version 1", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });
    await orders.put("ord_123", { status: "paid" });
    await orders.put("ord_other", { status: "held" });

    const removed = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "DELETE",
    });

    expect(removed.status).toBe(204);
    expect(removed.headers.get("content-type")).toBeNull();
    expect(removed.headers.get("content-length")).toBeNull();
    expect(await removed.text()).toBe("");

    await expect(orders.get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Record "ord_123" was not found in collection "orders".',
    });
    await expect(orders.get("ord_other")).resolves.toEqual({
      id: "ord_other",
      version: 1,
      data: { status: "held" },
    });

    const recreated = await orders.put("ord_123", { status: "open" }, { createOnly: true });

    expect(recreated).toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });

    await expect(orders.delete("ord_123")).resolves.toBeUndefined();
    await expect(orders.get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("returns 404 when deleting a missing record or a record in a missing collection", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });

    await expect(orders.delete("ord_missing")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Record "ord_missing" was not found in collection "orders".',
    });
    await expect(db.collection("missing").delete("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });

    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
    await expect(db.collection("missing").get("ord_123")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });
  });

  it("returns 400 for an invalid collection name or record id on delete and does not write", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });

    await expect(db.collection("1orders").delete("ord_123")).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message:
        'Collection name "1orders" is not allowed. Use a letter, then letters, digits, underscores, or hyphens, up to 63 characters.',
    });
    await expect(orders.delete("-bad")).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message:
        'Record id "-bad" is not allowed. Use letters, digits, and . _ : -, starting with a letter or digit, up to 128 characters.',
    });

    const invalidId = await fetch(`${running?.url}/v1/collections/orders/records/-bad`, {
      method: "DELETE",
    });

    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toMatchObject({
      error: { code: "invalid_argument" },
    });

    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("rejects If-Match, If-None-Match, and Idempotency-Key on delete and leaves the record unchanged", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });
    await db.collection("orders").put("ord_123", { status: "paid" });

    const baseUrl = `${running?.url}/v1/collections/orders/records/ord_123`;
    const cases = [
      {
        header: "if-match",
        value: '"2"',
        message: "If-Match is not supported yet. Conditional replaces are a follow-up.",
      },
      {
        header: "if-none-match",
        value: "*",
        message: "If-None-Match is not supported yet.",
      },
      {
        header: "idempotency-key",
        value: "delete-ord-123",
        message: "Idempotency-Key is not supported yet.",
      },
    ];

    for (const entry of cases) {
      const response = await fetch(baseUrl, {
        method: "DELETE",
        headers: { [entry.header]: entry.value },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "invalid_argument",
          message: entry.message,
        },
      });
    }

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });
  });

  it("rejects a query parameter or a body on delete and leaves the record unchanged", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "paid" });

    const conditional = await fetch(
      `${running?.url}/v1/collections/orders/records/ord_123?ifVersion=999`,
      { method: "DELETE" },
    );

    expect(conditional.status).toBe(400);
    await expect(conditional.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'Unknown query parameter "ifVersion". Delete does not support query parameters.',
      },
    });

    const withBody = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ifVersion: 999 }),
    });

    expect(withBody.status).toBe(400);
    await expect(withBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Delete does not accept a request body.",
      },
    });

    const plainBody = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "DELETE",
      headers: { "content-type": "text/plain" },
      body: "ifVersion=999",
    });

    expect(plainBody.status).toBe(400);
    await expect(plainBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "Delete does not accept a request body.",
      },
    });

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "paid" },
    });
  });
});

describe("parseCollectionName and parseRecordId", () => {
  it("rejects non-string values instead of coercing them into identifiers", () => {
    expect(() => parseCollectionName(123)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "Collection name must be a string.",
        details: { parameter: "name" },
      }),
    );
    expect(() => parseRecordId(123)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "Record id must be a string.",
        details: { parameter: "id" },
      }),
    );
    expect(parseCollectionName("orders")).toBe("orders");
    expect(parseRecordId("123")).toBe("123");
  });
});
