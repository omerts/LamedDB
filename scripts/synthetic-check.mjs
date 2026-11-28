#!/usr/bin/env node
// Synthetic check for a running LamedDB. It does a real round trip: create a
// temporary collection, write two records, find the expected one with a filtered
// list, prove a nonmatching filter returns nothing, read the record back, then
// delete the collection. A homepage-style 200 is not enough.
//
// The collection name is unique to this process. Cleanup runs only after this
// process created the collection, so a failed create cannot delete another
// check's collection. After a successful create, cleanup must return 204,
// including when a later assertion failed. A 404 there means the collection
// was not removed, and the check fails.
//
// LAMEDDB_URL                  base URL of the deployment to check (required)
// LAMEDDB_API_KEY              API key for that deployment (required)
// LAMEDDB_CHECK_EXPECT_STATUS  status value the check expects to find. Defaults
//                              to "paid", which is what the check writes. Set a
//                              different value to run a controlled failure.

import { randomBytes } from "node:crypto";

const baseUrl = requiredEnv("LAMEDDB_URL").replace(/\/+$/, "");
const apiKey = requiredEnv("LAMEDDB_API_KEY");
const expectStatus = process.env.LAMEDDB_CHECK_EXPECT_STATUS ?? "paid";
const timeoutMs = 10_000;
const collection = `synthetic_check_${Date.now().toString(36)}_${randomBytes(8).toString("hex")}`;
const recordId = "ord_synthetic_1";
const otherId = "ord_synthetic_2";
const written = { status: "paid", totalCents: 12900, createdAt: "2026-11-19T08:15:00.000Z" };
const other = { status: "open", totalCents: 500, createdAt: "2026-11-19T09:15:00.000Z" };
const excludedStatus = expectStatus === "nomatch" ? "absent" : "nomatch";

let createdCollection = false;
let failure = null;

function requiredEnv(name) {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    console.error(`synthetic-check: ${name} is required`);
    process.exit(2);
  }

  return value.trim();
}

function fail(message) {
  throw new Error(message);
}

function listPath(status) {
  return `/v1/collections/${collection}/records?filter%5Bstatus%5D=${encodeURIComponent(status)}&limit=10`;
}

function noteFailure(message) {
  const next = new Error(message);

  failure = failure === null ? next : new Error(`${failure.message}; ${next.message}`);
}

async function call(method, path, { body, auth = true } = {}) {
  const headers = {};

  if (auth) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;

  if (text !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      fail(`${method} ${path} returned a non-JSON body (status ${response.status})`);
    }
  }

  return { status: response.status, json };
}

function expectStatusCode(step, response, wanted) {
  if (response.status !== wanted) {
    fail(`${step}: expected HTTP ${wanted}, got ${response.status}`);
  }
}

async function run() {
  const health = await call("GET", "/health", { auth: false });
  expectStatusCode("health", health, 200);

  if (health.json?.status !== "ok") {
    fail("health: body is not {\"status\":\"ok\"}");
  }

  const created = await call("POST", "/v1/collections", {
    body: { name: collection, fields: { status: "string", totalCents: "integer", createdAt: "timestamp" } },
  });
  expectStatusCode("create collection", created, 201);
  createdCollection = true;

  const put = await call("PUT", `/v1/collections/${collection}/records/${recordId}`, { body: written });
  expectStatusCode("put record", put, 201);

  const putOther = await call("PUT", `/v1/collections/${collection}/records/${otherId}`, { body: other });
  expectStatusCode("put other record", putOther, 201);

  const found = await call("GET", listPath(expectStatus));
  expectStatusCode("filtered list", found, 200);
  const records = found.json?.records;

  if (!Array.isArray(records) || records.length !== 1) {
    fail(`filtered list: expected exactly 1 record with status "${expectStatus}", got ${Array.isArray(records) ? records.length : "no records array"}`);
  }

  const [record] = records;

  if (record.data?.status !== expectStatus) {
    fail(`filtered list: expected status "${expectStatus}", got ${JSON.stringify(record.data?.status)}`);
  }

  if (record.id !== recordId || record.data?.totalCents !== written.totalCents) {
    fail("filtered list: the record that came back is not the one that was written");
  }

  const excluded = await call("GET", listPath(excludedStatus));
  expectStatusCode("negative filter", excluded, 200);
  const excludedRecords = excluded.json?.records;

  if (!Array.isArray(excludedRecords) || excludedRecords.length !== 0) {
    fail(`negative filter: expected 0 records with status "${excludedStatus}", got ${Array.isArray(excludedRecords) ? excludedRecords.length : "no records array"}`);
  }

  const read = await call("GET", `/v1/collections/${collection}/records/${recordId}`);
  expectStatusCode("get record", read, 200);

  if (read.json?.version !== 1 || read.json?.data?.status !== written.status) {
    fail("get record: version or data does not match what was written");
  }
}

const started = Date.now();

try {
  await run();
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
}

// Delete only the collection this process created. A 404 is a failed cleanup:
// the instance that answered no longer has the collection this check just used.
if (createdCollection) {
  try {
    const removed = await call("DELETE", `/v1/collections/${collection}`);

    if (removed.status !== 204) {
      noteFailure(`cleanup: expected HTTP 204, got ${removed.status}`);
    }
  } catch (error) {
    noteFailure(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const elapsed = Date.now() - started;

if (failure !== null) {
  console.error(`synthetic-check FAIL ${new Date().toISOString()} ${elapsed}ms collection=${collection}: ${failure.message}`);
  process.exit(1);
}

console.log(`synthetic-check PASS ${new Date().toISOString()} ${elapsed}ms collection=${collection}: create, put, filtered list, get, cleanup all as expected`);
