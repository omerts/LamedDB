import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningServer } from "../src/index.js";
import { startTestServer, TEST_API_KEY } from "./helpers.js";

const execFileAsync = promisify(execFile);
const COLLECTION_NAME = /collection=(synthetic_check_[0-9a-z]+_[0-9a-f]{16})/;

interface CheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface StoredRecord {
  id: string;
  data: Record<string, unknown>;
}

interface StubBehavior {
  createStatus?: number;
  deleteStatus?: number;
  /** Every list returns every stored record, whatever the filter is. */
  listAll?: boolean;
  /** Every list returns the paid record, even when the filter asks for something else. */
  listPaidForEveryFilter?: boolean;
}

interface Stub {
  url: string;
  deletes: string[];
  createdNames: string[];
  close: () => Promise<void>;
}

async function runCheck(env: Record<string, string>): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/synthetic-check.mjs"], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });

    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };

    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

function collectionName(output: string): string {
  const name = COLLECTION_NAME.exec(output)?.[1];

  if (name === undefined) {
    throw new Error(`collection name missing from: ${output}`);
  }

  return name;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();

    return;
  }

  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function startStub(behavior: StubBehavior = {}): Promise<Stub> {
  const records: StoredRecord[] = [];
  const deletes: string[] = [];
  const createdNames: string[] = [];
  const createStatus = behavior.createStatus ?? 201;
  const deleteStatus = behavior.deleteStatus ?? 204;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { status: "ok" });

      return;
    }

    if (method === "POST" && url.pathname === "/v1/collections") {
      const body = JSON.parse(await readBody(req)) as { name?: string };

      if (typeof body.name === "string") {
        createdNames.push(body.name);
      }

      send(res, createStatus, { name: body.name });

      return;
    }

    const recordMatch = /^\/v1\/collections\/([^/]+)\/records\/([^/]+)$/.exec(url.pathname);

    if (recordMatch && method === "PUT") {
      const data = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const id = decodeURIComponent(recordMatch[2] ?? "");

      records.push({ id, data });
      send(res, 201, { id, version: 1, data });

      return;
    }

    if (recordMatch && method === "GET") {
      const id = decodeURIComponent(recordMatch[2] ?? "");
      const found = records.find((record) => record.id === id);

      send(res, 200, { id, version: 1, data: found?.data ?? {} });

      return;
    }

    if (method === "GET" && /^\/v1\/collections\/([^/]+)\/records$/.test(url.pathname)) {
      const status = url.searchParams.get("filter[status]");
      let listed = records;

      if (behavior.listPaidForEveryFilter) {
        listed = records.filter((record) => record.id === "ord_synthetic_1");
      } else if (!behavior.listAll) {
        listed = records.filter((record) => record.data["status"] === status);
      }

      send(res, 200, {
        records: listed.map((record) => ({ id: record.id, version: 1, data: record.data })),
        nextCursor: null,
      });

      return;
    }

    const collectionMatch = /^\/v1\/collections\/([^/]+)$/.exec(url.pathname);

    if (collectionMatch && method === "DELETE") {
      deletes.push(decodeURIComponent(collectionMatch[1] ?? ""));
      send(res, deleteStatus, deleteStatus === 204 ? undefined : { error: { code: "not_found", message: "missing" } });

      return;
    }

    send(res, 404, { error: { code: "not_found", message: "missing" } });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("stub server did not bind");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    deletes,
    createdNames,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("scripts/synthetic-check.mjs", () => {
  let running: RunningServer | undefined;
  const stubs: Stub[] = [];

  afterEach(async () => {
    await running?.close();
    running = undefined;
    await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  });

  async function start(): Promise<string> {
    const test = await startTestServer();
    running = test.server;

    return test.server.url;
  }

  async function stub(behavior: StubBehavior = {}): Promise<Stub> {
    const created = await startStub(behavior);

    stubs.push(created);

    return created;
  }

  it("passes against a healthy server and removes the collection", async () => {
    const url = await start();
    const result = await runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: TEST_API_KEY });
    const name = collectionName(result.stdout);
    const leftover = await fetch(`${url}/v1/collections/${name}/records`, {
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("synthetic-check PASS");
    expect(leftover.status).toBe(404);
  });

  it("gives concurrent checks different collection names", async () => {
    const url = await start();
    const [first, second] = await Promise.all([
      runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: TEST_API_KEY }),
      runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: TEST_API_KEY }),
    ]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(collectionName(first.stdout)).not.toBe(collectionName(second.stdout));
  });

  it("fails when the expected value is not returned and still deletes the collection", async () => {
    const url = await start();
    const result = await runCheck({
      LAMEDDB_URL: url,
      LAMEDDB_API_KEY: TEST_API_KEY,
      LAMEDDB_CHECK_EXPECT_STATUS: "refunded",
    });
    const name = collectionName(result.stderr);
    const leftover = await fetch(`${url}/v1/collections/${name}/records`, {
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("synthetic-check FAIL");
    expect(result.stderr).toContain('status "refunded"');
    expect(leftover.status).toBe(404);
  });

  it("fails when the list ignores the status filter", async () => {
    const server = await stub({ listAll: true });
    const result = await runCheck({ LAMEDDB_URL: server.url, LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('expected exactly 1 record with status "paid", got 2');
  });

  it("fails the controlled check when every filter returns the written record", async () => {
    const server = await stub({ listPaidForEveryFilter: true });
    const result = await runCheck({
      LAMEDDB_URL: server.url,
      LAMEDDB_API_KEY: TEST_API_KEY,
      LAMEDDB_CHECK_EXPECT_STATUS: "refunded",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('expected status "refunded"');
    expect(result.stdout).not.toContain("synthetic-check PASS");
  });

  it("fails when a nonmatching filter still returns a record", async () => {
    const server = await stub({ listPaidForEveryFilter: true });
    const result = await runCheck({ LAMEDDB_URL: server.url, LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('expected 0 records with status "nomatch"');
  });

  it("does not delete a collection it failed to create", async () => {
    const server = await stub({ createStatus: 409 });
    const result = await runCheck({ LAMEDDB_URL: server.url, LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("expected HTTP 201, got 409");
    expect(result.stderr).not.toContain("cleanup:");
    expect(server.deletes).toEqual([]);
    expect(server.createdNames).toHaveLength(1);
  });

  it("fails when cleanup returns 404 after a successful round trip", async () => {
    const server = await stub({ deleteStatus: 404 });
    const result = await runCheck({ LAMEDDB_URL: server.url, LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cleanup: expected HTTP 204, got 404");
    expect(result.stdout).not.toContain("synthetic-check PASS");
    expect(server.deletes).toEqual([collectionName(result.stderr)]);
  });

  it("fails and does not print the key when the key is wrong", async () => {
    const url = await start();
    const result = await runCheck({ LAMEDDB_URL: url, LAMEDDB_API_KEY: "not-the-key" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("expected HTTP 201, got 401");
    expect(result.stderr).not.toContain("not-the-key");
    expect(result.stderr).not.toContain("cleanup:");
  });

  it("exits 2 when the URL is missing", async () => {
    const result = await runCheck({ LAMEDDB_API_KEY: TEST_API_KEY });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("LAMEDDB_URL is required");
  });
});
