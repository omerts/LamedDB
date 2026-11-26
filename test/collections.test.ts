import { request as httpRequest } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LamedDB, LamedError, type FieldType, type JsonObject, type JsonValue, type RunningServer } from "../src/index.js";
import { LIMITS, parseCollectionName, parseRecordId, validateDocument } from "../src/validate.js";
import { startTestServer, TEST_API_KEY } from "./helpers.js";

const paidAt = "2026-11-19T08:15:00.000Z";
let fetch: typeof globalThis.fetch = globalThis.fetch;

describe("collections API", () => {
  let running: RunningServer | undefined;
  let db: LamedDB;

  beforeEach(async () => {
    const started = await startTestServer();

    running = started.server;
    db = started.db;
    fetch = started.fetch;
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

  it("deletes a record and continues the version when the same id is created again", async () => {
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
      version: 3,
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
        message: 'Unknown query parameter "ifVersion".',
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

  it("replaces a record when If-Match is the current version and returns the next one", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "open" });
    const fetched = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`);

    expect(created.version).toBe(1);
    expect(fetched.headers.get("etag")).toBe('"1"');

    const replaced = await orders.put("ord_123", { status: "paid" }, { ifVersion: 1 });
    const again = await fetch(`${running?.url}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": '"2"',
      },
      body: JSON.stringify({ status: "refunded" }),
    });

    expect(replaced).toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).toBe('"3"');
    await expect(again.json()).resolves.toEqual({
      id: "ord_123",
      version: 3,
      data: { status: "refunded" },
    });
    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 3,
      data: { status: "refunded" },
    });
  });

  it("returns 412 for a stale If-Match or for If-Match on a missing record and writes nothing", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });
    await orders.put("ord_123", { status: "paid" });

    await expect(orders.put("ord_123", { status: "refunded" }, { ifVersion: 1 })).rejects.toMatchObject({
      code: "precondition_failed",
      status: 412,
      message: 'Record "ord_123" in collection "orders" is version 2, not 1.',
    });
    await expect(orders.put("ord_missing", { status: "open" }, { ifVersion: 1 })).rejects.toMatchObject({
      code: "precondition_failed",
      status: 412,
      message: 'Record "ord_missing" was not found in collection "orders".',
    });
    await expect(db.collection("missing").put("ord_123", { status: "open" }, { ifVersion: 1 })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: 'Collection "missing" does not exist.',
    });

    await expect(orders.get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "paid" },
    });
    await expect(orders.get("ord_missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("returns 412 for a stale If-Match after the record is deleted and created again", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const created = await orders.put("ord_123", { status: "open" });

    expect(created.version).toBe(1);

    await orders.delete("ord_123");

    const recreated = await orders.put("ord_123", { status: "reopened" }, { createOnly: true });

    expect(recreated).toEqual({
      id: "ord_123",
      version: 2,
      data: { status: "reopened" },
    });

    await expect(orders.put("ord_123", { status: "stale" }, { ifVersion: 1 })).rejects.toMatchObject({
      code: "precondition_failed",
      status: 412,
      message: 'Record "ord_123" in collection "orders" is version 2, not 1.',
    });
    await expect(orders.get("ord_123")).resolves.toEqual(recreated);
  });

  it("returns 400 for a malformed If-Match and for If-Match combined with If-None-Match", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });

    const baseUrl = `${running?.url}/v1/collections/orders/records/ord_123`;
    const malformed = ["*", "1", '"1", "2"', 'W/"1"', '"abc"', '"01"'];

    for (const header of malformed) {
      const response = await fetch(baseUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-match": header,
        },
        body: JSON.stringify({ status: "paid" }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_argument" },
      });
    }

    const both = await fetch(baseUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": '"1"',
        "if-none-match": "*",
      },
      body: JSON.stringify({ status: "paid" }),
    });

    expect(both.status).toBe(400);
    await expect(both.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: "If-Match and If-None-Match cannot be used together.",
      },
    });

    await expect(
      db.collection("orders").put("ord_123", { status: "paid" }, { createOnly: true, ifVersion: 1 }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "If-Match and If-None-Match cannot be used together.",
    });
    await expect(
      db.collection("orders").put("ord_123", { status: "paid" }, { ifVersion: 1.5 }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "ifVersion must be a non-negative safe integer.",
    });

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });
  });

  it("lets only one of two concurrent If-Match writes on the same version succeed", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    await orders.put("ord_123", { status: "open" });

    const [first, second] = await Promise.allSettled([
      orders.put("ord_123", { status: "left" }, { ifVersion: 1 }),
      orders.put("ord_123", { status: "right" }, { ifVersion: 1 }),
    ]);
    const outcomes = [first, second];
    const succeeded = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const winner = succeeded[0];
    const loser = failed[0];

    if (winner?.status !== "fulfilled" || loser?.status !== "rejected") {
      throw new Error("Expected one successful If-Match write and one 412.");
    }

    expect(winner.value.version).toBe(2);
    expect(loser.reason).toMatchObject({
      code: "precondition_failed",
      status: 412,
    });
    await expect(orders.get("ord_123")).resolves.toEqual(winner.value);
  });

  it("rejects an unexpected query parameter or body before a read or a conditional write", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });
    await db.collection("orders").put("ord_123", { status: "open" });

    const putQuery = await fetch(
      `${running?.url}/v1/collections/orders/records/ord_123?ifVersion=1`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": '"1"' },
        body: JSON.stringify({ status: "paid" }),
      },
    );

    expect(putQuery.status).toBe(400);
    await expect(putQuery.json()).resolves.toMatchObject({
      error: {
        code: "invalid_argument",
        message: 'Unknown query parameter "ifVersion".',
      },
    });

    const getQuery = await fetch(`${running?.url}/v1/collections/orders/records/ord_123?ifVersion=1`);

    expect(getQuery.status).toBe(400);
    await expect(getQuery.json()).resolves.toMatchObject({
      error: { code: "invalid_argument", message: 'Unknown query parameter "ifVersion".' },
    });

    const getBody = await requestWithBody(
      `${running?.url}/v1/collections/orders/records/ord_123`,
      "GET",
      JSON.stringify({ ifVersion: 1 }),
      { "content-type": "application/json" },
    );

    expect(getBody.status).toBe(400);
    expect(getBody.json).toMatchObject({
      error: { code: "invalid_argument", message: "GET does not accept a request body." },
    });

    const createQuery = await fetch(`${running?.url}/v1/collections?ifVersion=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets" }),
    });

    expect(createQuery.status).toBe(400);

    await expect(db.collection("orders").get("ord_123")).resolves.toEqual({
      id: "ord_123",
      version: 1,
      data: { status: "open" },
    });

    const tickets = await fetch(`${running?.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets" }),
    });

    expect(tickets.status).toBe(201);
  });

  it("keeps a __proto__ field type and a __proto__ alias through create, put, and list", async () => {
    const fields = ownRecord<FieldType>([
      ["status", "string"],
      ["__proto__", "integer"],
    ]);
    const created = await db.admin.createCollection("orders", { fields });

    expect(Object.getPrototypeOf(created.fields)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(created.fields, "__proto__")?.value).toBe("integer");
    expect(created.fields["__proto__"]).toBe("integer");

    const orders = db.collection("orders");
    const wrong = ownRecord<JsonValue>([
      ["status", "open"],
      ["__proto__", "nope"],
    ]);

    await expect(orders.put("ord_1", wrong)).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: 'Field "__proto__" must be an integer in the safe integer range, or null.',
    });
    await expect(orders.get("ord_1")).rejects.toMatchObject({ code: "not_found", status: 404 });

    const right = ownRecord<JsonValue>([
      ["status", "open"],
      ["__proto__", 4],
    ]);
    const written = await orders.put("ord_1", right);
    const loaded = await orders.get("ord_1");

    expect(Object.getOwnPropertyDescriptor(written.data, "__proto__")?.value).toBe(4);
    expect(Object.getPrototypeOf(written.data)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(loaded.data, "__proto__")?.value).toBe(4);

    const aliases = ownRecord([["__proto__", "status"]]);
    const aliased = await db.admin.createCollection("tickets", {
      fields: { status: "string" },
      aliases,
    });

    if (aliased.aliases === undefined) {
      throw new Error("expected the alias to be returned");
    }

    expect(Object.getOwnPropertyDescriptor(aliased.aliases, "__proto__")?.value).toBe("status");
    expect(Object.getPrototypeOf(aliased.aliases)).toBe(Object.prototype);

    const tickets = db.collection("tickets");

    await tickets.put("ord_1", { status: "open" });
    await tickets.put("ord_2", { status: "paid" });

    const page = await tickets.list({ filter: ownRecord([["__proto__", "open"]]) });

    expect(page.records.map((record) => record.id)).toEqual(["ord_1"]);
  });

  it("rejects a NUL character in record JSON and does not remember the idempotency key", async () => {
    await db.admin.createCollection("orders", { fields: { status: "string" } });

    const orders = db.collection("orders");
    const nested = { status: "open", extra: {} as JsonObject };

    Object.defineProperty(nested.extra, "a\u0000", {
      value: true,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const cases: readonly { body: JsonObject; message: string }[] = [
      { body: { status: "a\u0000b" }, message: "String at $.status must not contain a NUL character." },
      { body: { status: "open", note: "a\u0000" }, message: "String at $.note must not contain a NUL character." },
      {
        body: { status: "open", extra: { note: "a\u0000" } },
        message: "String at $.extra.note must not contain a NUL character.",
      },
      {
        body: { status: "open", tags: ["ok", "a\u0000"] },
        message: "String at $.tags[1] must not contain a NUL character.",
      },
      {
        body: ownRecord<JsonValue>([
          ["status", "open"],
          ["a\u0000", 1],
        ]),
        message: "Object key at $ must not contain a NUL character.",
      },
      { body: nested, message: "Object key at $.extra must not contain a NUL character." },
    ];

    await expect(orders.put("ord_1", cases[0]?.body ?? { status: "a\u0000b" })).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "String at $.status must not contain a NUL character.",
    });

    for (const entry of cases) {
      await expect(orders.put("ord_1", entry.body, { idempotencyKey: "ord-1" })).rejects.toMatchObject({
        code: "invalid_argument",
        status: 400,
        message: entry.message,
      });
    }

    await expect(orders.get("ord_1")).rejects.toMatchObject({ code: "not_found", status: 404 });

    const written = await orders.put("ord_1", { status: "open\n\u0001" }, { idempotencyKey: "ord-1" });

    expect(written.data.status).toBe("open\n\u0001");
    await expect(orders.get("ord_1")).resolves.toEqual(written);
  });
});

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

function requestWithBody(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...headers,
          authorization: `Bearer ${TEST_API_KEY}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");

          resolve({
            status: res.statusCode ?? 0,
            json: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
          });
        });
      },
    );

    req.on("error", reject);
    req.end(body);
  });
}

describe("validateDocument", () => {
  it("rejects a NUL character in nested strings and keys and keeps other control characters", () => {
    const fields = { status: "string" as const };
    const nested = { status: "open", box: {} as Record<string, JsonValue> };

    Object.defineProperty(nested.box, "a\u0000", {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    expect(() => validateDocument({ status: "a\u0000b" }, fields)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "String at $.status must not contain a NUL character.",
      }),
    );
    expect(() => validateDocument({ status: "open", tags: [{ note: "a\u0000" }] }, fields)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "String at $.tags[0].note must not contain a NUL character.",
      }),
    );
    expect(() => validateDocument(nested, fields)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "Object key at $.box must not contain a NUL character.",
      }),
    );
    expect(validateDocument({ status: "open\n\u0001" }, fields)).toEqual({ status: "open\n\u0001" });
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
