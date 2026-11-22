import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer, type LamedMcpOptions } from "../src/mcp/server.js";
import { startTestServer, TEST_API_KEY, type TestServer } from "./helpers.js";

interface ToolText {
  isError?: boolean;
  text: string;
}

describe("MCP query_records", () => {
  let ts: TestServer;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    ts = await startTestServer();
    await ts.db.admin.createCollection("orders", {
      fields: { status: "string", totalCents: "integer" },
      aliases: { amount: "totalCents" },
    });

    for (let i = 1; i <= 6; i += 1) {
      await ts.db.collection("orders").put(`o${i}`, { status: i % 2 === 0 ? "paid" : "open", totalCents: i * 100 });
    }
  });

  afterEach(async () => {
    await ts.server.close();

    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function connect(options: Partial<LamedMcpOptions> = {}): Promise<Client> {
    const server = createMcpServer({ baseUrl: ts.server.url, apiKey: TEST_API_KEY, ...options });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(async () => {
      await client.close();
    });

    return client;
  }

  async function call(client: Client, args: Record<string, unknown>): Promise<ToolText> {
    const result = (await client.callTool({ name: "query_records", arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    const text = result.content.map((part) => part.text).join("\n");

    return result.isError === true ? { isError: true, text } : { text };
  }

  it("lists exactly one tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["query_records"]);
  });

  it("returns a page with a range filter, an alias and sort", async () => {
    const client = await connect();
    const result = await call(client, {
      collection: "orders",
      filter: { amount: { gte: 200, lt: 600 } },
      sort: "-amount",
      limit: 2,
    });
    const page = JSON.parse(result.text) as { records: { id: string }[]; nextCursor: string | null };

    expect(result.isError).toBeUndefined();
    expect(page.records.map((r) => r.id)).toEqual(["o5", "o4"]);
    expect(page.nextCursor).not.toBeNull();

    const next = await call(client, {
      collection: "orders",
      filter: { amount: { gte: 200, lt: 600 } },
      sort: "-amount",
      limit: 2,
      cursor: page.nextCursor,
    });

    expect((JSON.parse(next.text) as { records: { id: string }[] }).records.map((r) => r.id)).toEqual(["o3", "o2"]);
  });

  it("supports equality, in and prefix filters", async () => {
    const client = await connect();
    const paid = JSON.parse((await call(client, { collection: "orders", filter: { status: "paid" } })).text) as {
      records: unknown[];
    };
    const some = JSON.parse(
      (await call(client, { collection: "orders", filter: { id: { in: ["o1", "o2", "zzz"] } } })).text,
    ) as { records: unknown[] };
    const prefixed = JSON.parse(
      (await call(client, { collection: "orders", filter: { id: { prefix: "o" } }, limit: 100 })).text,
    ) as { records: unknown[] };

    expect(paid.records).toHaveLength(3);
    expect(some.records).toHaveLength(2);
    expect(prefixed.records).toHaveLength(6);
  });

  it.each<[string, Record<string, unknown>]>([
    ["unknown operator", { collection: "orders", filter: { amount: { between: 5 } } }],
    ["empty operator object", { collection: "orders", filter: { amount: {} } }],
    ["limit 0", { collection: "orders", limit: 0 }],
    ["limit above 100", { collection: "orders", limit: 101 }],
    ["fractional limit", { collection: "orders", limit: 1.5 }],
    ["bad collection name", { collection: "../etc" }],
    ["missing collection", { limit: 5 }],
    ["unknown argument", { collection: "orders", offset: 3 }],
    ["boolean filter value", { collection: "orders", filter: { status: true } }],
    ["object filter value", { collection: "orders", filter: { status: { eq: { a: 1 } } } }],
    ["empty in list", { collection: "orders", filter: { id: { in: [] } } }],
    ["too many in values", { collection: "orders", filter: { id: { in: Array.from({ length: 21 }, (_, i) => `x${i}`) } } }],
    ["bad filter field name", { collection: "orders", filter: { "a b": "x" } }],
    ["bad sort", { collection: "orders", sort: "--amount" }],
    ["empty cursor", { collection: "orders", cursor: "" }],
  ])("rejects invalid input: %s", async (_name, args) => {
    const client = await connect();
    const result = await call(client, args);

    expect(result.isError).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("rejects more than 10 filter fields", async () => {
    const client = await connect();
    const filter = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, "x"]));

    expect((await call(client, { collection: "orders", filter })).isError).toBe(true);
  });

  it("reports a server-side 400 (unknown field) as a tool error", async () => {
    const client = await connect();
    const result = await call(client, { collection: "orders", filter: { nope: "x" } });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Invalid request");
  });

  it("reports an unknown collection (404)", async () => {
    const client = await connect();
    const result = await call(client, { collection: "ghosts" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Not found");
  });

  it("reports a bad API key (401) without echoing it", async () => {
    const secret = "wrong-key-SECRET-123";
    const client = await connect({ apiKey: secret });
    const result = await call(client, { collection: "orders" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("401");
    expect(result.text).not.toContain(secret);
  });

  it("reports a server that is down", async () => {
    const down = await startTestServer();
    const url = down.server.url;

    await down.server.close();

    const client = await connect({ baseUrl: url });
    const result = await call(client, { collection: "orders" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Could not reach LamedDB");
    expect(result.text).not.toContain(TEST_API_KEY);
  });

  it("reports a timeout", async () => {
    const hung: Server = createServer(() => {
      // Never answer.
    });

    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          hung.closeAllConnections();
          hung.close(() => resolve());
        }),
    );

    const { port } = hung.address() as AddressInfo;
    const client = await connect({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 100 });
    const result = await call(client, { collection: "orders" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Timed out after 100 ms");
  });

  it("reports an unexpected payload from a non-LamedDB server as a tool error", async () => {
    const odd: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>");
    });

    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => odd.close(() => resolve())));

    const { port } = odd.address() as AddressInfo;
    const client = await connect({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await call(client, { collection: "orders" });

    expect(result.isError).toBe(true);
  });

  it("refuses to build a server with a bad key, URL or timeout", () => {
    expect(() => createMcpServer({ baseUrl: "http://x", apiKey: "" })).toThrow();
    expect(() => createMcpServer({ baseUrl: "http://x", apiKey: "has space" })).toThrow();
    expect(() => createMcpServer({ baseUrl: " ", apiKey: "k" })).toThrow();
    expect(() => createMcpServer({ baseUrl: "http://x", apiKey: "k", timeoutMs: 0 })).toThrow();
  });
});
