import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { RunningServer } from "../src/index.js";
import { startTestServer, TEST_API_KEY } from "./helpers.js";

describe("GET /health", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function start(): Promise<string> {
    const test = await startTestServer();
    running = test.server;

    return test.server.url;
  }

  it("returns 200 {status: ok} without an API key", async () => {
    const url = await start();
    const response = await fetch(`${url}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns the same body with a valid or a wrong key", async () => {
    const url = await start();

    for (const authorization of [`Bearer ${TEST_API_KEY}`, "Bearer wrong-key"]) {
      const response = await fetch(`${url}/health`, { headers: { authorization } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    }
  });

  it("leaks nothing: no keys, version, or collection names in the body or headers", async () => {
    const test = await startTestServer();
    running = test.server;
    await test.db.admin.createCollection("secret_orders");
    const response = await fetch(`${test.server.url}/health`);
    const text = await response.text();
    const headers = JSON.stringify([...response.headers.entries()]);

    expect(text).toBe('{"status":"ok"}');
    expect(text + headers).not.toContain(TEST_API_KEY);
    expect(text + headers).not.toContain("secret_orders");
  });

  it("does not open any other route: they still return 401 without a key", async () => {
    const url = await start();
    const requests: Array<[string, string]> = [
      ["GET", "/"],
      ["GET", "/healthz"],
      ["GET", "/health/"],
      ["GET", "/health/x"],
      ["POST", "/v1/collections"],
      ["DELETE", "/v1/collections/orders"],
      ["GET", "/v1/collections/orders/records/a"],
    ];

    for (const [method, path] of requests) {
      const response = await fetch(`${url}${path}`, { method });

      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("other methods on /health need a key, then get 405 with Allow: GET", async () => {
    const test = await startTestServer();
    running = test.server;

    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const anonymous = await fetch(`${test.server.url}/health`, { method });

      expect(anonymous.status, method).toBe(401);

      const keyed = await test.fetch(`${test.server.url}/health`, { method });

      expect(keyed.status, method).toBe(405);
      expect(keyed.headers.get("allow")).toBe("GET");
    }
  });

  it("rejects an unknown query parameter like every other route", async () => {
    const url = await start();
    const response = await fetch(`${url}/health?verbose=1`);

    expect(response.status).toBe(400);
  });

  it("rejects If-Match, If-None-Match and Idempotency-Key with 400, with and without a key", async () => {
    const test = await startTestServer();
    running = test.server;
    const url = `${test.server.url}/health`;
    const headers: Array<[string, string]> = [
      ["if-match", '"1"'],
      ["if-none-match", "*"],
      ["idempotency-key", "k"],
    ];

    for (const [name, value] of headers) {
      for (const send of [fetch, test.fetch]) {
        const response = await send(url, { headers: { [name]: value } });
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status, name).toBe(400);
        expect(body.error.code).toBe("invalid_argument");
      }
    }
  });

  it("rejects a request body with 400 without reading it, with and without a key", async () => {
    const test = await startTestServer();
    running = test.server;
    const { port } = test.server;

    for (const extra of [`content-length: 5\r\n\r\nhello`, "transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"]) {
      for (const auth of ["", `authorization: Bearer ${TEST_API_KEY}\r\n`]) {
        const raw = `GET /health HTTP/1.1\r\nhost: x\r\n${auth}${extra}`;
        const reply = await rawRequest(port, raw);

        expect(reply.split("\r\n")[0], raw).toContain("400");
        expect(reply).toContain("invalid_argument");
      }
    }
  });

  it("a bad header plus a body on GET /health returns 400 and closes the connection", async () => {
    const test = await startTestServer();
    running = test.server;
    const headers = ['if-match: "1"', "if-none-match: *", "idempotency-key: k"];

    for (const header of headers) {
      for (const auth of ["", `authorization: Bearer ${TEST_API_KEY}\r\n`]) {
        const raw = `GET /health HTTP/1.1\r\nhost: x\r\n${auth}${header}\r\ncontent-length: 5\r\n\r\nhello`;
        const result = await rawRequestInfo(test.server.port, raw);

        expect(result.reply.split("\r\n")[0], raw).toContain("400");
        expect(result.reply.toLowerCase()).toContain("connection: close");
        expect(result.closed, raw).toBe(true);
      }
    }
  });

  it("POST /health with an incomplete body and no key gets an early 401 and closes", async () => {
    const test = await startTestServer();
    running = test.server;
    const raw = "POST /health HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\n\r\npartial";
    const result = await rawRequestInfo(test.server.port, raw);

    expect(result.reply.split("\r\n")[0]).toContain("401");
    expect(result.closed).toBe(true);
    expect(result.ms).toBeLessThan(1000);
  });

  it("a plain GET /health with content-length: 0 is still 200", async () => {
    const url = await start();
    const port = Number(new URL(url).port);
    const reply = await rawRequest(port, "GET /health HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");

    expect(reply.split("\r\n")[0]).toContain("200");
    expect(reply).toContain('{"status":"ok"}');
  });
});

async function rawRequest(port: number, raw: string): Promise<string> {
  return (await rawRequestInfo(port, raw)).reply;
}

/** Send raw bytes. `closed` is true when the server ended the connection before the timeout. */
function rawRequestInfo(
  port: number,
  raw: string,
  waitMs = 1500,
): Promise<{ reply: string; closed: boolean; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let data = "";
    let done = false;
    const finish = (closed: boolean): void => {
      if (done) {
        return;
      }

      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ reply: data, closed, ms: Date.now() - started });
    };
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(raw);
    });
    const timer = setTimeout(() => {
      finish(false);
    }, waitMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("close", () => {
      finish(true);
    });
    socket.on("error", reject);
  });
}
