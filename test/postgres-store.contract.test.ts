import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { escapeIdentifier, Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  ENGINE_OPERATIONS,
  LamedError,
  PostgresStore,
  postgresStoreDescriptor,
  type PostgresStoreOptions,
  type StoredChange,
} from "../src/index.js";
import { databaseUrlFromEnv } from "../src/validate.js";
import type { StoreContractOptions } from "./store-contract.js";
import { runStoreContract } from "./store-contract.js";

const SECRET = "super-secret-db-pass";
const UNREACHABLE = `postgres://lamed:${SECRET}@127.0.0.1:1/lameddb`;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const testDatabaseUrl = configuredDatabaseUrl(process.env.LAMEDDB_TEST_DATABASE_URL);

describe("PostgresStore options and startup", () => {
  it("describes a durable write authority for every current operation", () => {
    const descriptor = postgresStoreDescriptor();

    expect(descriptor).toMatchObject({
      kind: "postgres",
      roles: ["write-authority"],
      recovery: "durable",
      ordering: true,
      exactness: "exact",
      snapshot: "per-call",
    });
    expect(descriptor.operations).toEqual([...ENGINE_OPERATIONS]);
  });

  it("rejects a missing URL, a bad schema, a bad clock, and unknown options", () => {
    expect(() => new PostgresStore({} as PostgresStoreOptions)).toThrow(
      expect.objectContaining({ message: "Database URL must be a non-empty string." }),
    );
    expect(() => new PostgresStore({ connectionString: "   " })).toThrow(/non-empty string/);
    expect(() => new PostgresStore({ connectionString: UNREACHABLE, schema: "Bad-Name" })).toThrow(/Schema name/);
    expect(
      () => new PostgresStore({ connectionString: UNREACHABLE, now: "no" as unknown as () => number }),
    ).toThrow(/Clock must be a function/);
    expect(
      () => new PostgresStore({ connectionString: UNREACHABLE, extra: true } as PostgresStoreOptions),
    ).toThrow(/Unknown store option "extra"/);

    const hidden: PostgresStoreOptions = { connectionString: UNREACHABLE };

    Object.defineProperty(hidden, "lane", { value: true, enumerable: false });
    expect(() => new PostgresStore(hidden)).toThrow(/Unknown store option "lane"/);
    expect(
      () =>
        new PostgresStore({
          connectionString: UNREACHABLE,
          [Symbol("lane")]: true,
        } as unknown as PostgresStoreOptions),
    ).toThrow(/Unknown store option/);
  });

  it("reads LAMEDDB_DATABASE_URL without copying it into an error", () => {
    expect(databaseUrlFromEnv({})).toBeUndefined();
    expect(databaseUrlFromEnv({ LAMEDDB_DATABASE_URL: `  ${UNREACHABLE}  ` })).toBe(UNREACHABLE);
    expect(() => databaseUrlFromEnv(null as unknown as { LAMEDDB_DATABASE_URL?: string })).toThrow(
      /Environment must be an object/,
    );

    for (const env of [
      { LAMEDDB_DATABASE_URL: "" },
      { LAMEDDB_DATABASE_URL: "   " },
      { LAMEDDB_DATABASE_URL: 12 as unknown as string },
    ]) {
      const error = errorFrom(() => databaseUrlFromEnv(env));

      expect(error).toBeInstanceOf(LamedError);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(UNREACHABLE);
    }
  });

  it("does not include the database URL when migrate cannot connect", async () => {
    const store = new PostgresStore({ connectionString: UNREACHABLE });

    try {
      const error = await rejected(store.migrate());
      const text = errorText(error);

      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(UNREACHABLE);
    } finally {
      await store.close();
    }
  }, 20_000);

  it("exits when the database URL is unreachable and does not reveal it", async () => {
    const result = await runCli({
      ...process.env,
      LAMEDDB_API_KEYS: "dev-key",
      LAMEDDB_DATABASE_URL: UNREACHABLE,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Could not open the database");
    expect(result.stderr).toContain("LAMEDDB_DATABASE_URL");
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stderr).not.toContain(UNREACHABLE);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toContain(UNREACHABLE);
    expect(result.stdout).not.toContain("LamedDB listening");
  }, 20_000);

  it("exits when the database URL is blank and does not listen", async () => {
    const result = await runCli({
      ...process.env,
      LAMEDDB_API_KEYS: "dev-key",
      LAMEDDB_DATABASE_URL: "   ",
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("LAMEDDB_DATABASE_URL is set but empty");
    expect(result.stdout).not.toContain("LamedDB listening");
  }, 20_000);
});

if (testDatabaseUrl === undefined) {
  console.info("Skipping PostgreSQL store contract: LAMEDDB_TEST_DATABASE_URL is not set.");

  describe("PostgresStore contract", () => {
    it.skip("runs against PostgreSQL when LAMEDDB_TEST_DATABASE_URL is set", () => {});
  });
} else {
  const databaseUrl = testDatabaseUrl;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 10_000,
  });
  const schemas: string[] = [];

  pool.on("error", () => {
    // The next query reports a dropped idle client.
  });

  afterAll(async () => {
    for (const schema of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
    }

    await pool.end();
  });

  runStoreContract("PostgresStore", async (options) => {
    const schema = `c_${randomBytes(8).toString("hex")}`;

    schemas.push(schema);

    const store = new PostgresStore(contractStoreOptions(databaseUrl, schema, pool, options));

    await store.migrate();

    return store;
  });

  describe("PostgresStore durability and change log", () => {
    it("creates an idempotent index for idempotency retention order", async () => {
      const schema = `i_${randomBytes(8).toString("hex")}`;

      schemas.push(schema);

      const store = new PostgresStore(contractStoreOptions(databaseUrl, schema, pool, undefined));

      try {
        await store.migrate();
        await store.migrate();

        const indexes = await pool.query<{ indexdef: string }>(
          `SELECT indexdef
           FROM pg_indexes
           WHERE schemaname = $1
             AND tablename = 'idempotency'
             AND indexname = 'idempotency_stored_at_seq'`,
          [schema],
        );

        expect(indexes.rows).toHaveLength(1);
        expect(indexes.rows[0]?.indexdef).toContain("(collection, stored_at, seq)");
      } finally {
        await store.close();
      }
    });

    it("keeps records after the store is closed and migrate runs twice", async () => {
      const schema = `d_${randomBytes(8).toString("hex")}`;

      schemas.push(schema);

      const firstPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
      const first = new PostgresStore({ connectionString: databaseUrl, schema, pool: firstPool });

      try {
        await first.migrate();
        await first.createCollection("orders", { status: "string" }, { state: "status" });

        const created = await first.getCollection("orders");

        if (created === null) {
          throw new Error("expected the collection to be stored");
        }

        const written = await first.putRecord({
          collection: "orders",
          id: "a",
          data: { status: "open" },
          createOnly: false,
          collectionRevision: created.revision,
        });

        await first.migrate();
        expect(await first.getRecord("orders", "a")).toEqual(written.record);
        expect((await first.getCollection("orders"))?.revision).toBe(created.revision);
        await first.close();
      } finally {
        await firstPool.end();
      }

      const secondPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
      const second = new PostgresStore({ connectionString: databaseUrl, schema, pool: secondPool });

      try {
        await second.migrate();
        expect(await second.getRecord("orders", "a")).toEqual({
          id: "a",
          version: 1,
          data: { status: "open" },
        });
        expect((await second.getCollection("orders"))?.aliases).toEqual({ state: "status" });
      } finally {
        await secondPool.end();
      }
    });

    it("writes one change per committed put or delete, and none when the transaction rolls back", async () => {
      const clock = { millis: 50 };
      const { store, release } = await openStore({ now: () => clock.millis });

      try {
        await store.createCollection("orders", { status: "string" });

        const orders = await store.getCollection("orders");

        if (orders === null) {
          throw new Error("expected the collection to be stored");
        }

        await store.putRecord({
          collection: "orders",
          id: "a",
          data: { status: "open" },
          createOnly: false,
          collectionRevision: orders.revision,
        });
        clock.millis = 60;
        await store.putRecord({
          collection: "orders",
          id: "a",
          data: { status: "paid" },
          createOnly: false,
          collectionRevision: orders.revision,
          idempotency: { key: "paid", fingerprint: "paid" },
        });
        clock.millis = 70;
        expect(await store.deleteRecord("orders", "a")).toBe(true);
        expect(await store.listChanges("orders")).toEqual([
          { position: 1, type: "put", id: "a", version: 1, time: 50 },
          { position: 2, type: "put", id: "a", version: 2, time: 60 },
          { position: 3, type: "delete", id: "a", version: 2, time: 70 },
        ] satisfies StoredChange[]);

        const beforeReplay = await store.listChanges("orders");

        await store.putRecord({
          collection: "orders",
          id: "a",
          data: { status: "paid" },
          createOnly: false,
          collectionRevision: orders.revision,
          idempotency: { key: "paid", fingerprint: "paid" },
        });
        await expect(
          store.putRecord({
            collection: "orders",
            id: "b",
            data: { status: "open" },
            createOnly: true,
            collectionRevision: orders.revision,
            ifVersion: 1,
            idempotency: { key: "bad", fingerprint: "bad" },
          }),
        ).rejects.toMatchObject({ code: "invalid_argument" });
        expect(await store.listChanges("orders")).toEqual(beforeReplay);
        expect(await store.deleteCollection("orders")).toBe(true);

        await store.createCollection("orders", { status: "string" });

        const recreated = await store.getCollection("orders");

        if (recreated === null) {
          throw new Error("expected the collection to be stored again");
        }

        expect(await store.listChanges("orders")).toEqual([]);

        const failing = await openFailingStore();

        try {
          await failing.store.createCollection("orders", { status: "string" });

          const target = await failing.store.getCollection("orders");

          if (target === null) {
            throw new Error("expected the failing store collection");
          }

          await expect(
            failing.store.putRecord({
              collection: "orders",
              id: "a",
              data: { status: "open" },
              createOnly: true,
              collectionRevision: target.revision,
              idempotency: { key: "once", fingerprint: "once" },
            }),
          ).rejects.toThrow("forced failure");
          expect(await failing.store.getRecord("orders", "a")).toBeNull();
          expect(await failing.store.listChanges("orders")).toEqual([]);

          failing.store.armed = false;
          const written = await failing.store.putRecord({
            collection: "orders",
            id: "a",
            data: { status: "open" },
            createOnly: true,
            collectionRevision: target.revision,
            idempotency: { key: "once", fingerprint: "once" },
          });

          expect(written.record).toEqual({ id: "a", version: 1, data: { status: "open" } });
          expect(await failing.store.getRecord("orders", "a")).toEqual(written.record);
          expect(await failing.store.listChanges("orders")).toEqual([
            { position: 1, type: "put", id: "a", version: 1, time: expect.any(Number) },
          ]);
        } finally {
          await failing.release();
        }
      } finally {
        await release();
      }
    });
  });

  async function openStore(
    options: StoreContractOptions = {},
  ): Promise<{ store: PostgresStore; release: () => Promise<void> }> {
    const schema = `b_${randomBytes(8).toString("hex")}`;

    schemas.push(schema);

    const store = new PostgresStore(contractStoreOptions(databaseUrl, schema, pool, options));

    await store.migrate();

    return { store, release: async () => {} };
  }

  async function openFailingStore(): Promise<{ store: ForcedFailureStore; release: () => Promise<void> }> {
    const schema = `f_${randomBytes(8).toString("hex")}`;

    schemas.push(schema);

    const store = new ForcedFailureStore({
      connectionString: databaseUrl,
      schema,
      pool,
    });

    await store.migrate();

    return { store, release: async () => {} };
  }
}

class ForcedFailureStore extends PostgresStore {
  armed = true;

  protected override async beforeCommit(): Promise<void> {
    if (this.armed) {
      throw new Error("forced failure");
    }
  }
}

function configuredDatabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.trim();
}

function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }

  throw new Error("expected a thrown error");
}

async function rejected(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }

  throw new Error("expected a rejected promise");
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  }

  return String(error);
}

function runCli(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [tsx, "src/cli.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return collect(child);
}

function contractStoreOptions(
  connectionString: string,
  schema: string,
  pool: Pool,
  options: StoreContractOptions | undefined,
): PostgresStoreOptions {
  const parsed: PostgresStoreOptions = { connectionString, schema, pool };

  if (options !== undefined && options.now !== undefined) {
    parsed.now = options.now;
  }

  if (options !== undefined && options.idempotencyTtlMs !== undefined) {
    parsed.idempotencyTtlMs = options.idempotencyTtlMs;
  }

  if (options !== undefined && options.maxIdempotencyKeys !== undefined) {
    parsed.maxIdempotencyKeys = options.maxIdempotencyKeys;
  }

  return parsed;
}

function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });

  return once(child, "exit").then(([code]) => ({
    code: code as number | null,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  }));
}
