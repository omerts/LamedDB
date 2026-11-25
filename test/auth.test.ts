import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LamedDB,
  LamedError,
  listen,
  type LamedDBOptions,
  type ListenOptions,
  type RunningServer,
  type Store,
} from "../src/index.js";
import { apiKeysFromEnv, isValidApiKey, LIMITS, parseApiKeys } from "../src/validate.js";
import { startTestServer } from "./helpers.js";

const API_KEY = "super-secret-key-9f3a";
const OTHER_KEY = "other-secret-key-11b2";
const UNAUTHENTICATED_MESSAGE = "A valid API key is required.";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

describe("API key authentication", () => {
  const running: RunningServer[] = [];

  afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close()));
  });

  it("refuses to start without keys and says why", async () => {
    const missing = listen(undefined as unknown as ListenOptions);
    const empty = listen({ apiKeys: [], host: "127.0.0.1" });
    const blank = listen({ apiKeys: [""] });
    const whitespace = listen({ apiKeys: ["dev key"] });
    const notAnArray = listen({ apiKeys: "dev-key" as unknown as string[] });
    const notAString = listen({ apiKeys: [1] as unknown as readonly string[] });

    await expect(missing).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "At least one API key is required. The server refuses to start without apiKeys.",
    });
    await expect(empty).rejects.toMatchObject({
      message: "At least one API key is required. The server refuses to start without apiKeys.",
    });
    await expect(blank).rejects.toMatchObject({
      message:
        "API keys must be non-empty printable ASCII strings with no spaces or control characters.",
    });
    await expect(whitespace).rejects.toMatchObject({
      message:
        "API keys must be non-empty printable ASCII strings with no spaces or control characters.",
    });
    await expect(notAnArray).rejects.toMatchObject({
      message: "At least one API key is required. The server refuses to start without apiKeys.",
    });
    await expect(notAString).rejects.toMatchObject({
      message:
        "API keys must be non-empty printable ASCII strings with no spaces or control characters.",
    });
    expect(() => parseApiKeys(undefined)).toThrow(LamedError);
    expect(parseApiKeys([API_KEY, OTHER_KEY])).toEqual([API_KEY, OTHER_KEY]);
  });

  it("reads LAMEDDB_API_KEYS and rejects a missing, blank, or empty entry", () => {
    expect(apiKeysFromEnv({ LAMEDDB_API_KEYS: " one , two " })).toEqual(["one", "two"]);
    expect(() => apiKeysFromEnv({})).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        message: expect.stringContaining("LAMEDDB_API_KEYS is required"),
      }),
    );
    expect(() => apiKeysFromEnv({ LAMEDDB_API_KEYS: "" })).toThrow(
      expect.objectContaining({ message: expect.stringContaining("refuses to start") }),
    );
    expect(() => apiKeysFromEnv({ LAMEDDB_API_KEYS: "   " })).toThrow(
      expect.objectContaining({ message: expect.stringContaining("LAMEDDB_API_KEYS is required") }),
    );
    expect(() => apiKeysFromEnv({ LAMEDDB_API_KEYS: 12 as unknown as string })).toThrow(
      expect.objectContaining({ message: expect.stringContaining("LAMEDDB_API_KEYS is required") }),
    );
    expect(() => apiKeysFromEnv({ LAMEDDB_API_KEYS: "one,,two" })).toThrow(
      expect.objectContaining({ message: expect.stringContaining("empty key") }),
    );
    expect(() => apiKeysFromEnv(null as unknown as { LAMEDDB_API_KEYS?: string })).toThrow(
      expect.objectContaining({ message: "Environment must be an object." }),
    );
  });

  it("returns 401 for every route when the key is missing or wrong and leaves storage unchanged", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY] });

    running.push(started.server);

    await started.db.admin.createCollection("orders", { fields: { status: "string" } });

    const created = await started.db.collection("orders").put("ord_123", { status: "open" });
    const routes = [
      { method: "POST", path: "/v1/collections", body: JSON.stringify({ name: "tickets" }) },
      { method: "DELETE", path: "/v1/collections/orders" },
      {
        method: "PUT",
        path: "/v1/collections/orders/records/ord_123",
        body: JSON.stringify({ status: "paid" }),
      },
      { method: "GET", path: "/v1/collections/orders/records/ord_123" },
      { method: "DELETE", path: "/v1/collections/orders/records/ord_123" },
      { method: "GET", path: "/no-such-route" },
      { method: "PATCH", path: "/v1/collections/orders/records/ord_123" },
      { method: "GET", path: "/v1/collections" },
    ];
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      for (const route of routes) {
        const missingHeaders: Record<string, string> =
          route.body === undefined ? {} : { "content-type": "application/json" };
        const missingInit: RequestInit = { method: route.method, headers: missingHeaders };

        if (route.body !== undefined) {
          missingInit.body = route.body;
        }

        const missing = await fetch(started.server.url + route.path, missingInit);
        const wrongHeaders: Record<string, string> = {
          authorization: `Bearer ${OTHER_KEY}`,
          ...(route.body === undefined ? {} : { "content-type": "application/json" }),
        };
        const wrongInit: RequestInit = { method: route.method, headers: wrongHeaders };

        if (route.body !== undefined) {
          wrongInit.body = route.body;
        }

        const wrong = await fetch(started.server.url + route.path, wrongInit);

        await expectUnauthenticated(missing, [API_KEY, OTHER_KEY]);
        await expectUnauthenticated(wrong, [API_KEY, OTHER_KEY]);
      }
    } finally {
      spy.mockRestore();
    }

    expect(logged).toEqual([]);
    await expect(started.db.collection("orders").get("ord_123")).resolves.toEqual(created);
    await expect(started.db.admin.createCollection("tickets")).resolves.toMatchObject({ name: "tickets" });
  });

  it("rejects malformed credentials and does not echo the key", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY] });

    running.push(started.server);

    const cases = [
      `Basic ${API_KEY}`,
      `Bearers ${API_KEY}`,
      `bearer${API_KEY}`,
      `bearer ${API_KEY.toUpperCase()}`,
      "bearer",
      "Bearer",
      `Bearer  ${API_KEY}`,
      `Bearer ${API_KEY.slice(0, API_KEY.length - 1)}`,
    ];

    for (const authorization of cases) {
      const response = await fetch(`${started.server.url}/v1/collections/orders`, {
        method: "DELETE",
        headers: { authorization },
      });

      await expectUnauthenticated(response, [API_KEY, API_KEY.slice(0, -1)]);
    }

    const duplicate = await sendRaw(
      started.server.port,
      [
        "DELETE /v1/collections/orders HTTP/1.1",
        "host: 127.0.0.1",
        `authorization: Bearer ${API_KEY}`,
        `authorization: Bearer ${API_KEY}`,
        "connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    expect(duplicate.status).toBe(401);
    expect(duplicate.headers.toLowerCase()).toContain("www-authenticate: bearer");
    expect(JSON.parse(duplicate.body)).toEqual({
      error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE },
    });
    expect(duplicate.body).not.toContain(API_KEY);
    expect(duplicate.headers).not.toContain(API_KEY);
  });

  it("accepts the Bearer scheme in any letter case and keeps the token case-sensitive", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY] });

    running.push(started.server);
    await started.db.admin.createCollection("orders");

    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) {
      const response = await fetch(`${started.server.url}/v1/collections/orders/records`, {
        headers: { authorization: `${scheme} ${API_KEY}` },
      });

      expect(response.status).toBe(200);
    }

    for (const scheme of ["bearer", "BEARER"]) {
      const response = await fetch(`${started.server.url}/v1/collections/orders/records`, {
        headers: { authorization: `${scheme} ${OTHER_KEY}` },
      });

      await expectUnauthenticated(response, [API_KEY, OTHER_KEY]);
    }
  });

  it("returns 401 before reading the body, the method, or the route", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY] });

    running.push(started.server);

    const invalidJson = await fetch(`${started.server.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const plainBody = await fetch(`${started.server.url}/v1/collections`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "tickets" }),
    });
    const query = await fetch(`${started.server.url}/v1/collections?ifVersion=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "tickets" }),
    });
    const precondition = await fetch(`${started.server.url}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "not-a-version" },
      body: JSON.stringify({ status: "paid" }),
    });
    const partial = await sendRaw(
      started.server.port,
      [
        "POST /v1/collections HTTP/1.1",
        "host: 127.0.0.1",
        "content-type: application/json",
        `content-length: ${LIMITS.maxBodyBytes + 32}`,
        "connection: close",
        "",
        "{",
      ].join("\r\n"),
    );

    await expectUnauthenticated(invalidJson, [API_KEY]);
    await expectUnauthenticated(plainBody, [API_KEY]);
    await expectUnauthenticated(query, [API_KEY]);
    await expectUnauthenticated(precondition, [API_KEY]);
    expect(partial.status).toBe(401);
    expect(partial.body).not.toContain("1 MiB");
    expect(JSON.parse(partial.body)).toMatchObject({ error: { code: "unauthenticated" } });

    const authedInvalid = await fetch(`${started.server.url}/v1/collections`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });

    expect(authedInvalid.status).toBe(400);
    await expect(authedInvalid.json()).resolves.toMatchObject({
      error: { code: "invalid_argument" },
    });

    const unknown = await fetch(`${started.server.url}/no-such-route`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const method = await fetch(`${started.server.url}/v1/collections`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(unknown.status).toBe(404);
    expect(method.status).toBe(405);
    await expect(started.db.admin.createCollection("tickets")).resolves.toMatchObject({ name: "tickets" });
  });

  it("rejects a malformed request target without logging an internal error", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY] });

    running.push(started.server);

    await started.db.admin.createCollection("orders", { fields: { status: "string" } });

    const created = await started.db.collection("orders").put("ord_123", { status: "open" });
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    const request = (authorization?: string): string => {
      const lines = ["GET http://[::1 HTTP/1.1", "host: 127.0.0.1"];

      if (authorization !== undefined) {
        lines.push(`authorization: ${authorization}`);
      }

      lines.push("connection: close", "", "");

      return lines.join("\r\n");
    };

    try {
      const missing = await sendRaw(started.server.port, request());
      const wrong = await sendRaw(started.server.port, request(`Bearer ${OTHER_KEY}`));
      const valid = await sendRaw(started.server.port, request(`Bearer ${API_KEY}`));

      expect(missing.status).toBe(401);
      expect(missing.headers.toLowerCase()).toContain("www-authenticate: bearer");
      expect(JSON.parse(missing.body)).toEqual({
        error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE },
      });
      expect(wrong.status).toBe(401);
      expect(JSON.parse(wrong.body)).toEqual({
        error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE },
      });
      expect(valid.status).toBe(400);
      expect(JSON.parse(valid.body)).toEqual({
        error: { code: "invalid_argument", message: "Request target is not a valid URL." },
      });
      expect(missing.body + wrong.body + valid.body).not.toContain(API_KEY);
      expect(missing.headers + wrong.headers + valid.headers).not.toContain(API_KEY);
    } finally {
      spy.mockRestore();
    }

    expect(logged).toEqual([]);
    await expect(started.db.collection("orders").get("ord_123")).resolves.toEqual(created);
  });

  it("accepts every configured key and the SDK maps a wrong key to unauthenticated", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY, OTHER_KEY] });

    running.push(started.server);

    let seenAuthorization: string | null = null;
    const db = new LamedDB({
      baseUrl: started.server.url,
      apiKey: API_KEY,
      fetch: async (input, init) => {
        seenAuthorization = new Headers(init?.headers).get("authorization");

        return fetch(input, init);
      },
    });

    await expect(db.admin.createCollection("orders", { fields: { status: "string" } })).resolves.toMatchObject({
      name: "orders",
    });
    expect(seenAuthorization).toBe(`Bearer ${API_KEY}`);

    const second = await fetch(`${started.server.url}/v1/collections/orders/records/ord_123`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${OTHER_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "open" }),
    });

    expect(second.status).toBe(201);

    const wrong = new LamedDB({ baseUrl: started.server.url, apiKey: "wrong-key" });

    await expect(wrong.admin.createCollection("tickets")).rejects.toMatchObject({
      name: "LamedError",
      code: "unauthenticated",
      status: 401,
      message: UNAUTHENTICATED_MESSAGE,
    });
    await expect(wrong.collection("orders").get("ord_123")).rejects.toMatchObject({
      code: "unauthenticated",
      status: 401,
    });
    await expect(db.collection("orders").get("ord_123")).resolves.toMatchObject({
      id: "ord_123",
      data: { status: "open" },
    });
    await expect(db.admin.createCollection("tickets")).resolves.toMatchObject({ name: "tickets" });
  });

  it("requires a non-empty string apiKey before sending a request", () => {
    const baseUrl = "http://127.0.0.1:9";
    const missing = { baseUrl } as LamedDBOptions;
    const blanks = ["", "   "];
    const others = [1, null, undefined, { key: API_KEY }];

    expect(() => new LamedDB(missing)).toThrow(
      expect.objectContaining({
        code: "invalid_argument",
        status: 400,
        message: "apiKey is required.",
      }),
    );

    for (const apiKey of blanks) {
      expect(() => new LamedDB({ baseUrl, apiKey })).toThrow(
        expect.objectContaining({ code: "invalid_argument", message: "apiKey is required." }),
      );
    }

    for (const apiKey of others) {
      expect(() => new LamedDB({ baseUrl, apiKey: apiKey as unknown as string })).toThrow(
        expect.objectContaining({ code: "invalid_argument", message: "apiKey is required." }),
      );
    }
  });

  it("rejects spaces, control characters, and non-ASCII keys, and a valid key still works", async () => {
    const baseUrl = "http://127.0.0.1:9";
    const rejected = ["good key", "good\u0001key", "good€key"];
    const serverMessage =
      "API keys must be non-empty printable ASCII strings with no spaces or control characters.";
    const sdkMessage = "apiKey must be printable ASCII with no spaces or control characters.";

    for (const apiKey of rejected) {
      expect(isValidApiKey(apiKey)).toBe(false);

      const parsed = errorFrom(() => parseApiKeys([apiKey]));
      const constructed = errorFrom(() => new LamedDB({ baseUrl, apiKey }));

      expect(parsed).toMatchObject({
        code: "invalid_argument",
        status: 400,
        message: serverMessage,
      });
      expect(constructed).toMatchObject({
        code: "invalid_argument",
        status: 400,
        message: sdkMessage,
      });
      expect(parsed.message).not.toContain(apiKey);
      expect(constructed.message).not.toContain(apiKey);
    }

    expect(isValidApiKey("dev-key")).toBe(true);
    expect(parseApiKeys(["dev-key"])).toEqual(["dev-key"]);
    expect(() => new LamedDB({ baseUrl, apiKey: "dev-key" })).not.toThrow();

    const started = await startTestServer({ apiKeys: ["dev-key"] });

    running.push(started.server);

    await expect(started.db.admin.createCollection("orders")).resolves.toMatchObject({
      name: "orders",
    });
  });

  it("does not log the API key or the Authorization header when a later call fails", async () => {
    const started = await startTestServer({ apiKeys: [API_KEY], store: explodingStore() });

    running.push(started.server);

    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const response = await fetch(`${started.server.url}/v1/collections`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "orders" }),
      });
      const text = await response.text();
      const error = logged[0]?.[0];

      expect(response.status).toBe(500);
      expect(text).not.toContain(API_KEY);
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(logged).toHaveLength(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("headers");
      expect(error).not.toHaveProperty("req");
      expect((error as Error).message).toBe("store failed");
      expect((error as Error).stack ?? "").not.toContain(API_KEY);
      expect(((error as Error).stack ?? "").toLowerCase()).not.toContain("authorization");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("CLI startup", () => {
  it("refuses to start when LAMEDDB_API_KEYS is unset and says why", async () => {
    const result = await runCli(cliEnv());

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("LAMEDDB_API_KEYS is required");
    expect(result.stderr).toContain("refuses to start");
    expect(result.stdout).not.toContain("LamedDB listening");
  }, 20_000);

  it("listens when LAMEDDB_API_KEYS is set", async () => {
    const child = startCli({ ...cliEnv(), LAMEDDB_API_KEYS: "dev-key", HOST: "127.0.0.1", PORT: "0" });
    const streams = cliStreams(child);
    let stdout = "";
    let stderr = "";

    streams.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    streams.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      await waitForListen(child, () => stdout);

      expect(stdout).toContain("LamedDB listening on http://127.0.0.1:");
      expect(stderr).not.toContain("dev-key");
      expect(stdout).not.toContain("dev-key");
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }, 20_000);
});

function errorFrom(run: () => unknown): LamedError {
  try {
    run();
  } catch (error) {
    if (error instanceof LamedError) {
      return error;
    }

    throw error;
  }

  throw new Error("expected an invalid_argument error");
}

async function expectUnauthenticated(response: Response, secrets: readonly string[]): Promise<void> {
  const text = await response.text();

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe("Bearer");
  expect(JSON.parse(text)).toEqual({
    error: { code: "unauthenticated", message: UNAUTHENTICATED_MESSAGE },
  });

  for (const secret of secrets) {
    expect(text).not.toContain(secret);
    expect(response.headers.get("www-authenticate")).not.toContain(secret);
  }
}

function explodingStore(): Store {
  const fail = (): never => {
    throw new Error("store failed");
  };

  return {
    createCollection: async () => fail(),
    getCollection: async () => fail(),
    deleteCollection: async () => fail(),
    putRecord: async () => fail(),
    getRecord: async () => fail(),
    deleteRecord: async () => fail(),
    listRecords: async () => fail(),
  };
}

function sendRaw(port: number, raw: string): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(raw);
    });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }

      const text = Buffer.concat(chunks).toString("utf8");
      const separator = text.indexOf("\r\n\r\n");

      if (separator === -1) {
        return;
      }

      const headers = text.slice(0, separator);
      const body = text.slice(separator + 4);
      const lengthMatch = /content-length:\s*(\d+)/i.exec(headers);

      if (lengthMatch?.[1] !== undefined && Buffer.byteLength(body) < Number(lengthMatch[1])) {
        return;
      }

      settled = true;
      socket.destroy();

      const statusLine = headers.split("\r\n")[0] ?? "";

      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body,
      });
    };

    socket.setTimeout(1_000, () => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(new Error("timed out waiting for a response"));
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      finish();
    });
    socket.on("error", (error: Error) => {
      if (settled) {
        return;
      }

      finish();

      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.on("end", finish);
  });
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.LAMEDDB_API_KEYS;

  return env;
}

function cliStreams(child: ChildProcess): { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream } {
  if (child.stdout === null || child.stderr === null) {
    throw new Error("CLI stdout and stderr must be piped.");
  }

  return { stdout: child.stdout, stderr: child.stderr };
}

function startCli(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [tsx, "src/cli.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runCli(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = startCli(env);
  const streams = cliStreams(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  streams.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  streams.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

  const [code] = (await once(child, "exit")) as [number | null];

  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function waitForListen(child: ChildProcess, readStdout: () => string): Promise<void> {
  const stdout = child.stdout;

  if (stdout === null) {
    return Promise.reject(new Error("CLI stdout is not piped."));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CLI did not start.\n${readStdout()}`));
    }, 15_000);

    const onStdout = (): void => {
      if (!readStdout().includes("LamedDB listening")) {
        return;
      }

      clearTimeout(timer);
      stdout.off("data", onStdout);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(`CLI exited ${code} before listening.\n${readStdout()}`));
    };

    stdout.on("data", onStdout);
    child.once("exit", onExit);
  });
}
