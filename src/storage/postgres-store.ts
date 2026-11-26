import { DatabaseError, escapeIdentifier, Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";

import { LamedError } from "../errors.js";
import type { AliasMap, CollectionInfo, FieldMap, FieldType, JsonObject, RecordEnvelope } from "../types.js";
import { assertNoEmbeddedNul, parsePostgresStoreOptions } from "../validate.js";
import { compareRecords, isAfter, matchesFilters } from "./query.js";
import type {
  CollectionState,
  IdempotentPut,
  ListRecordsInput,
  ListRecordsResult,
  PutRecordInput,
  PutRecordResult,
  Store,
} from "./store.js";

/** One committed put or delete. Position increases by 1 for each committed mutation in the collection. */
export interface StoredChange {
  position: number;
  type: "put" | "delete";
  id: string;
  version: number;
  time: number;
}

export interface PostgresStoreOptions {
  /** PostgreSQL connection URL. Never copied into an error or a log line. */
  connectionString: string;
  /** Schema that holds this store's tables. Defaults to `lameddb`. */
  schema?: string;
  /** Shared pool. When omitted, the store opens and closes its own. */
  pool?: Pool;
  /** Millisecond clock. Tests inject one so expiry does not wait on wall time. */
  now?: () => number;
  /** How long a stored key stays replayable. Defaults to 24 hours. */
  idempotencyTtlMs?: number;
  /** How many keys one collection keeps. The oldest is dropped past this. */
  maxIdempotencyKeys?: number;
}

interface LiveKey {
  fingerprint: string;
  created: boolean;
  record: RecordEnvelope;
}

/**
 * Durable store on PostgreSQL.
 * A collection row lock makes the version check, the write, the change-log append,
 * and the idempotency update one transaction, so concurrent writers cannot both commit.
 * `migrate` creates the schema and can run more than once.
 * Listing reads one statement, then applies the same filter and sort rules as `MemoryStore`.
 */
export class PostgresStore implements Store {
  private readonly connectionString: string;

  private readonly schemaName: string;

  private readonly schemaSql: string;

  private readonly collections: string;

  private readonly records: string;

  private readonly versions: string;

  private readonly idempotency: string;

  private readonly idempotencyOrderIndex: string;

  private readonly changes: string;

  private readonly meta: string;

  private readonly sequenceRegclass: string;

  private readonly pool: Pool;

  private readonly ownsPool: boolean;

  private readonly now: () => number;

  private readonly idempotencyTtlMs: number;

  private readonly maxIdempotencyKeys: number;

  constructor(options: PostgresStoreOptions) {
    const parsed = parsePostgresStoreOptions(options);

    this.connectionString = parsed.connectionString;
    this.schemaName = parsed.schema;
    this.schemaSql = escapeIdentifier(parsed.schema);
    this.collections = `${this.schemaSql}.collections`;
    this.records = `${this.schemaSql}.records`;
    this.versions = `${this.schemaSql}.versions`;
    this.idempotency = `${this.schemaSql}.idempotency`;
    // Index names cannot be schema-qualified. PostgreSQL creates the index in the table's schema.
    this.idempotencyOrderIndex = escapeIdentifier("idempotency_stored_at_seq");
    this.changes = `${this.schemaSql}.changes`;
    this.meta = `${this.schemaSql}.meta`;
    this.sequenceRegclass = `${this.schemaSql}.idempotency_seq`;
    this.now = parsed.now;
    this.idempotencyTtlMs = parsed.idempotencyTtlMs;
    this.maxIdempotencyKeys = parsed.maxIdempotencyKeys;

    if (parsed.pool === undefined) {
      this.pool = openPool(parsed.connectionString);
      this.ownsPool = true;
    } else {
      this.pool = parsed.pool as Pool;
      this.ownsPool = false;
    }
  }

  /** Create the schema and tables. A second call leaves existing rows in place. */
  async migrate(): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.collections} (
          name text PRIMARY KEY,
          fields jsonb NOT NULL,
          aliases jsonb NOT NULL,
          revision bigint NOT NULL,
          next_change bigint NOT NULL
        )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.records} (
          collection text NOT NULL REFERENCES ${this.collections} (name) ON DELETE CASCADE,
          id text NOT NULL,
          version bigint NOT NULL,
          data jsonb NOT NULL,
          PRIMARY KEY (collection, id)
        )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.versions} (
          collection text NOT NULL REFERENCES ${this.collections} (name) ON DELETE CASCADE,
          id text NOT NULL,
          version bigint NOT NULL,
          PRIMARY KEY (collection, id)
        )`,
      );
      await client.query(`CREATE SEQUENCE IF NOT EXISTS ${this.sequenceRegclass}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.idempotency} (
          collection text NOT NULL REFERENCES ${this.collections} (name) ON DELETE CASCADE,
          idempotency_key text NOT NULL,
          fingerprint text NOT NULL,
          was_created boolean NOT NULL,
          record_id text NOT NULL,
          record_version bigint NOT NULL,
          record_data jsonb NOT NULL,
          stored_at bigint NOT NULL,
          seq bigint NOT NULL,
          PRIMARY KEY (collection, idempotency_key)
        )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.changes} (
          collection text NOT NULL REFERENCES ${this.collections} (name) ON DELETE CASCADE,
          log_position bigint NOT NULL,
          change_type text NOT NULL CHECK (change_type IN ('put', 'delete')),
          record_id text NOT NULL,
          version bigint NOT NULL,
          at_ms bigint NOT NULL,
          PRIMARY KEY (collection, log_position)
        )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.meta} (
          id integer PRIMARY KEY CHECK (id = 1),
          next_revision bigint NOT NULL
        )`,
      );
      await client.query(
        `INSERT INTO ${this.meta} (id, next_revision) VALUES (1, 1) ON CONFLICT (id) DO NOTHING`,
      );
    });

    await this.ensureIdempotencyOrderIndex();
  }

  /**
   * Build the retention index outside the startup transaction.
   * `CREATE INDEX CONCURRENTLY` does not block writes on an existing table.
   * A failed build leaves an invalid index; the next migrate drops it and tries again.
   */
  private async ensureIdempotencyOrderIndex(): Promise<void> {
    if ((await this.idempotencyOrderIndexState()) === "valid") {
      return;
    }

    await this.queryAutocommit(
      `DROP INDEX CONCURRENTLY IF EXISTS ${this.schemaSql}.${this.idempotencyOrderIndex}`,
    );

    try {
      await this.queryAutocommit(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${this.idempotencyOrderIndex}
         ON ${this.idempotency} (collection, stored_at, seq)`,
      );
    } catch (error) {
      if ((await this.idempotencyOrderIndexState()) === "valid") {
        return;
      }

      throw error;
    }
  }

  private async idempotencyOrderIndexState(): Promise<"valid" | "invalid" | "missing"> {
    let rows: { valid: boolean }[];

    try {
      const result = await this.pool.query<{ valid: boolean }>(
        `SELECT index_entry.indisvalid AS valid
         FROM pg_class AS index_rel
         JOIN pg_namespace AS namespace ON namespace.oid = index_rel.relnamespace
         JOIN pg_index AS index_entry ON index_entry.indexrelid = index_rel.oid
         WHERE namespace.nspname = $1
           AND index_rel.relname = $2`,
        [this.schemaName, "idempotency_stored_at_seq"],
      );

      rows = result.rows;
    } catch (error) {
      throw redact(error, this.connectionString);
    }

    const row = rows[0];

    if (row === undefined) {
      return "missing";
    }

    return row.valid === true ? "valid" : "invalid";
  }

  private async queryAutocommit(text: string): Promise<void> {
    try {
      await this.pool.query(text);
    } catch (error) {
      throw redact(error, this.connectionString);
    }
  }

  /** Close the pool this store opened. A shared pool is left running. */
  async close(): Promise<void> {
    if (!this.ownsPool) {
      return;
    }

    await this.pool.end();
  }

  async createCollection(name: string, fields: FieldMap, aliases: AliasMap = {}): Promise<CollectionInfo> {
    const storedFields = cloneFields(fields);
    const storedAliases = cloneAliases(aliases);

    return this.withTransaction(async (client) => {
      const revision = await this.allocateRevision(client);
      const existing = await this.rows<{ present: number }>(
        client,
        `SELECT 1 AS present FROM ${this.collections} WHERE name = $1`,
        [name],
      );

      if (existing.length > 0) {
        throw new LamedError("already_exists", `Collection "${name}" already exists.`);
      }

      try {
        await client.query(
          `INSERT INTO ${this.collections} (name, fields, aliases, revision, next_change)
           VALUES ($1, $2::jsonb, $3::jsonb, $4, 0)`,
          [name, JSON.stringify(storedFields), JSON.stringify(storedAliases), revision],
        );
      } catch (error) {
        if (error instanceof DatabaseError && error.code === "23505") {
          throw new LamedError("already_exists", `Collection "${name}" already exists.`);
        }

        throw error;
      }

      return collectionInfo(name, storedFields, storedAliases);
    });
  }

  async getCollection(name: string): Promise<CollectionState | null> {
    const rows = await this.rowsFromPool<{ fields: unknown; aliases: unknown; revision: string }>(
      `SELECT fields, aliases, revision::text AS revision FROM ${this.collections} WHERE name = $1`,
      [name],
    );
    const row = rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      ...collectionInfo(name, readFields(row.fields), readAliases(row.aliases)),
      revision: readInteger(row.revision, "revision"),
    };
  }

  async deleteCollection(name: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const removed = await client.query(`DELETE FROM ${this.collections} WHERE name = $1`, [name]);

      return (removed.rowCount ?? 0) > 0;
    });
  }

  async putRecord(input: PutRecordInput): Promise<PutRecordResult> {
    const data = cloneDocument(input.data);

    return this.withTransaction(async (client) => {
      const collection = await this.lockCollection(client, input.collection);

      if (!Number.isSafeInteger(input.collectionRevision) || input.collectionRevision < 0) {
        throw new LamedError("invalid_argument", "Collection revision must be a non-negative safe integer.");
      }

      if (collection.revision !== input.collectionRevision) {
        throw new LamedError("not_found", `Collection "${input.collection}" was replaced before the write.`);
      }

      assertNoEmbeddedNul(data);

      const clock = this.readNow();
      const idempotency = input.idempotency;
      const recorded =
        idempotency === undefined
          ? undefined
          : await this.liveEntry(client, input.collection, idempotency.key, clock);

      if (idempotency !== undefined && recorded !== undefined) {
        if (recorded.fingerprint !== idempotency.fingerprint) {
          throw new LamedError(
            "idempotency_conflict",
            `Idempotency key "${idempotency.key}" was already used for a different request.`,
            { idempotencyKey: idempotency.key },
          );
        }

        return {
          created: recorded.created,
          record: cloneRecord(recorded.record),
        };
      }

      if (input.ifVersion !== undefined && input.createOnly) {
        throw new LamedError("invalid_argument", "If-Match and If-None-Match cannot be used together.");
      }

      const existing = await this.lockRecord(client, input.collection, input.id);

      if (input.ifVersion !== undefined) {
        if (existing === undefined) {
          throw new LamedError(
            "precondition_failed",
            `Record "${input.id}" was not found in collection "${input.collection}".`,
          );
        }

        if (existing.version !== input.ifVersion) {
          throw new LamedError(
            "precondition_failed",
            `Record "${input.id}" in collection "${input.collection}" is version ${existing.version}, not ${input.ifVersion}.`,
          );
        }
      } else if (existing !== undefined && input.createOnly) {
        throw new LamedError(
          "precondition_failed",
          `Record "${input.id}" already exists in collection "${input.collection}".`,
        );
      }

      const version = (await this.lastVersion(client, input.collection, input.id)) + 1;
      const record: RecordEnvelope = { id: input.id, version, data };

      await this.writeRecord(client, input.collection, record, existing !== undefined);
      await this.appendChange(client, input.collection, "put", input.id, version, clock);

      if (idempotency !== undefined) {
        await this.remember(client, input.collection, idempotency, existing === undefined, record, clock);
      }

      await this.beforeCommit();

      return {
        created: existing === undefined,
        record: cloneRecord(record),
      };
    });
  }

  async getRecord(collection: string, id: string): Promise<RecordEnvelope | null> {
    const rows = await this.rowsFromPool<{ id: string | null; version: string | null; data: unknown }>(
      `SELECT r.id AS id, r.version::text AS version, r.data AS data
       FROM ${this.collections} AS c
       LEFT JOIN ${this.records} AS r ON r.collection = c.name AND r.id = $2
       WHERE c.name = $1`,
      [collection, id],
    );
    const row = rows[0];

    if (row === undefined || typeof row.id !== "string" || row.version === null) {
      return null;
    }

    return {
      id: row.id,
      version: readInteger(row.version, "version"),
      data: readJsonObject(row.data),
    };
  }

  async deleteRecord(collection: string, id: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      await this.lockCollection(client, collection);

      const existing = await this.lockRecord(client, collection, id);

      if (existing === undefined) {
        return false;
      }

      const clock = this.readNow();

      await client.query(`DELETE FROM ${this.records} WHERE collection = $1 AND id = $2`, [collection, id]);
      await this.appendChange(client, collection, "delete", id, existing.version, clock);
      await this.beforeCommit();

      return true;
    });
  }

  async listRecords(input: ListRecordsInput): Promise<ListRecordsResult> {
    const rows = await this.rowsFromPool<{
      revision: string;
      id: string | null;
      version: string | null;
      data: unknown;
    }>(
      `SELECT c.revision::text AS revision, r.id AS id, r.version::text AS version, r.data AS data
       FROM ${this.collections} AS c
       LEFT JOIN ${this.records} AS r ON r.collection = c.name
       WHERE c.name = $1`,
      [input.collection],
    );
    const first = rows[0];

    if (first === undefined) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
    }

    if (readInteger(first.revision, "revision") !== input.collectionRevision) {
      throw new LamedError("not_found", `Collection "${input.collection}" does not exist.`);
    }

    const matching: RecordEnvelope[] = [];

    for (const row of rows) {
      if (typeof row.id !== "string" || row.version === null) {
        continue;
      }

      const record: RecordEnvelope = {
        id: row.id,
        version: readInteger(row.version, "version"),
        data: readJsonObject(row.data),
      };

      if (matchesFilters(record, input.filters)) {
        matching.push(record);
      }
    }

    matching.sort((left, right) => compareRecords(left, right, input.sort));

    const after = input.after;
    const remaining =
      after === undefined ? matching : matching.filter((record) => isAfter(record, after, input.sort));

    return {
      records: remaining.slice(0, input.limit).map(cloneRecord),
      hasMore: remaining.length > input.limit,
    };
  }

  /** Committed changes for one collection, oldest first. A missing collection is `not_found`. */
  async listChanges(collection: string): Promise<StoredChange[]> {
    const rows = await this.rowsFromPool<{
      log_position: string | null;
      change_type: string | null;
      record_id: string | null;
      version: string | null;
      at_ms: string | null;
    }>(
      `SELECT ch.log_position::text AS log_position,
              ch.change_type,
              ch.record_id,
              ch.version::text AS version,
              ch.at_ms::text AS at_ms
       FROM ${this.collections} AS c
       LEFT JOIN ${this.changes} AS ch ON ch.collection = c.name
       WHERE c.name = $1
       ORDER BY ch.log_position ASC`,
      [collection],
    );

    if (rows.length === 0) {
      throw new LamedError("not_found", `Collection "${collection}" does not exist.`);
    }

    const changes: StoredChange[] = [];

    for (const row of rows) {
      if (row.log_position === null || row.change_type === null || row.record_id === null || row.version === null || row.at_ms === null) {
        continue;
      }

      if (row.change_type !== "put" && row.change_type !== "delete") {
        throw new LamedError("internal", "Stored change is unreadable.");
      }

      changes.push({
        position: readInteger(row.log_position, "position"),
        type: row.change_type,
        id: row.record_id,
        version: readInteger(row.version, "version"),
        time: readInteger(row.at_ms, "time"),
      });
    }

    return changes;
  }

  /**
   * Runs after a mutation is staged and before commit.
   * A throw rolls the transaction back, including the change-log row.
   */
  protected async beforeCommit(): Promise<void> {
    return;
  }

  private async allocateRevision(client: PoolClient): Promise<number> {
    const rows = await this.rows<{ revision: string }>(
      client,
      `UPDATE ${this.meta}
       SET next_revision = next_revision + 1
       WHERE id = 1
       RETURNING (next_revision - 1)::text AS revision`,
      [],
    );
    const row = rows[0];

    if (row === undefined) {
      throw new LamedError("internal", "Database schema is not ready.");
    }

    return readInteger(row.revision, "revision");
  }

  private async lockCollection(client: PoolClient, name: string): Promise<{ revision: number }> {
    const rows = await this.rows<{ revision: string }>(
      client,
      `SELECT revision::text AS revision FROM ${this.collections} WHERE name = $1 FOR UPDATE`,
      [name],
    );
    const row = rows[0];

    if (row === undefined) {
      throw new LamedError("not_found", `Collection "${name}" does not exist.`);
    }

    return { revision: readInteger(row.revision, "revision") };
  }

  private async lockRecord(client: PoolClient, collection: string, id: string): Promise<RecordEnvelope | undefined> {
    const rows = await this.rows<{ id: string; version: string; data: unknown }>(
      client,
      `SELECT id, version::text AS version, data
       FROM ${this.records}
       WHERE collection = $1 AND id = $2
       FOR UPDATE`,
      [collection, id],
    );
    const row = rows[0];

    if (row === undefined) {
      return undefined;
    }

    return {
      id: row.id,
      version: readInteger(row.version, "version"),
      data: readJsonObject(row.data),
    };
  }

  private async lastVersion(client: PoolClient, collection: string, id: string): Promise<number> {
    const rows = await this.rows<{ version: string }>(
      client,
      `SELECT version::text AS version FROM ${this.versions} WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    const row = rows[0];

    if (row === undefined) {
      return 0;
    }

    return readInteger(row.version, "version");
  }

  private async writeRecord(
    client: PoolClient,
    collection: string,
    record: RecordEnvelope,
    exists: boolean,
  ): Promise<void> {
    if (exists) {
      await client.query(
        `UPDATE ${this.records} SET version = $3, data = $4::jsonb WHERE collection = $1 AND id = $2`,
        [collection, record.id, record.version, JSON.stringify(record.data)],
      );
    } else {
      await client.query(
        `INSERT INTO ${this.records} (collection, id, version, data) VALUES ($1, $2, $3, $4::jsonb)`,
        [collection, record.id, record.version, JSON.stringify(record.data)],
      );
    }

    await client.query(
      `INSERT INTO ${this.versions} (collection, id, version) VALUES ($1, $2, $3)
       ON CONFLICT (collection, id) DO UPDATE SET version = EXCLUDED.version`,
      [collection, record.id, record.version],
    );
  }

  private async appendChange(
    client: PoolClient,
    collection: string,
    type: "put" | "delete",
    id: string,
    version: number,
    time: number,
  ): Promise<void> {
    const updated = await this.rows<{ position: string }>(
      client,
      `UPDATE ${this.collections}
       SET next_change = next_change + 1
       WHERE name = $1
       RETURNING next_change::text AS position`,
      [collection],
    );
    const position = updated[0]?.position;

    if (position === undefined) {
      throw new LamedError("not_found", `Collection "${collection}" does not exist.`);
    }

    await client.query(
      `INSERT INTO ${this.changes} (collection, log_position, change_type, record_id, version, at_ms)
       VALUES ($1, $2::bigint, $3, $4, $5, $6)`,
      [collection, position, type, id, version, time],
    );
  }

  private async liveEntry(client: PoolClient, collection: string, key: string, now: number): Promise<LiveKey | undefined> {
    const rows = await this.rows<{
      fingerprint: string;
      was_created: boolean;
      record_id: string;
      record_version: string;
      record_data: unknown;
      stored_at: string;
    }>(
      client,
      `SELECT fingerprint, was_created, record_id, record_version::text AS record_version, record_data, stored_at::text AS stored_at
       FROM ${this.idempotency}
       WHERE collection = $1 AND idempotency_key = $2`,
      [collection, key],
    );
    const row = rows[0];

    if (row === undefined || isExpired(readInteger(row.stored_at, "stored_at"), now, this.idempotencyTtlMs)) {
      return undefined;
    }

    return {
      fingerprint: row.fingerprint,
      created: row.was_created === true,
      record: {
        id: row.record_id,
        version: readInteger(row.record_version, "version"),
        data: readJsonObject(row.record_data),
      },
    };
  }

  private async remember(
    client: PoolClient,
    collection: string,
    idempotency: IdempotentPut,
    created: boolean,
    record: RecordEnvelope,
    now: number,
  ): Promise<void> {
    await this.deleteExpiredPrefix(client, collection, now);
    await client.query(`DELETE FROM ${this.idempotency} WHERE collection = $1 AND idempotency_key = $2`, [
      collection,
      idempotency.key,
    ]);

    const newest = await this.newestStoredAt(client, collection);
    const storedAt = newest !== undefined && now < newest ? newest : now;
    const snapshot = cloneRecord(record);

    await client.query(
      `INSERT INTO ${this.idempotency}
        (collection, idempotency_key, fingerprint, was_created, record_id, record_version, record_data, stored_at, seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, nextval($9::regclass))`,
      [
        collection,
        idempotency.key,
        idempotency.fingerprint,
        created,
        snapshot.id,
        snapshot.version,
        JSON.stringify(snapshot.data),
        storedAt,
        this.sequenceRegclass,
      ],
    );
    await this.dropOverCap(client, collection);
  }

  /**
   * Expired keys are a prefix of (stored_at, seq). Delete that prefix and stop before the first live key.
   * A key is live when stored_at > now - ttl. A backwards clock pins stored_at, so a newer key cannot
   * expire while an older one is still live. Both statements use the (collection, stored_at, seq) index.
   */
  private async deleteExpiredPrefix(client: PoolClient, collection: string, now: number): Promise<void> {
    const boundary = await this.rows<{ stored_at: string; seq: string }>(
      client,
      `SELECT stored_at::text AS stored_at, seq::text AS seq
       FROM ${this.idempotency}
       WHERE collection = $1
         AND stored_at > $2::bigint - $3::bigint
       ORDER BY stored_at ASC, seq ASC
       LIMIT 1`,
      [collection, now, this.idempotencyTtlMs],
    );
    const firstLive = boundary[0];

    if (firstLive === undefined) {
      await client.query(
        `DELETE FROM ${this.idempotency}
         WHERE collection = $1
           AND stored_at <= $2::bigint - $3::bigint`,
        [collection, now, this.idempotencyTtlMs],
      );

      return;
    }

    await client.query(
      `DELETE FROM ${this.idempotency}
       WHERE collection = $1
         AND (stored_at, seq) < ($2::bigint, $3::bigint)`,
      [collection, firstLive.stored_at, firstLive.seq],
    );
  }

  private async newestStoredAt(client: PoolClient, collection: string): Promise<number | undefined> {
    const rows = await this.rows<{ newest: string | null }>(
      client,
      `SELECT max(stored_at)::text AS newest FROM ${this.idempotency} WHERE collection = $1`,
      [collection],
    );
    const newest = rows[0]?.newest;

    if (newest === null || newest === undefined) {
      return undefined;
    }

    return readInteger(newest, "stored_at");
  }

  /** Drop keys older than the newest `maxIdempotencyKeys`, using the stored-time index. */
  private async dropOverCap(client: PoolClient, collection: string): Promise<void> {
    await client.query(
      `DELETE FROM ${this.idempotency} AS target
       USING (
         SELECT stored_at, seq
         FROM ${this.idempotency}
         WHERE collection = $1
         ORDER BY stored_at DESC, seq DESC
         OFFSET $2
       ) AS overflow
       WHERE target.collection = $1
         AND target.stored_at = overflow.stored_at
         AND target.seq = overflow.seq`,
      [collection, this.maxIdempotencyKeys],
    );
  }

  private readNow(): number {
    const now = this.now();

    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
      throw new LamedError(
        "internal",
        "Clock must return a non-negative safe integer timestamp in milliseconds.",
      );
    }

    return now;
  }

  private async withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();

    try {
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '10s'");

        const result = await run(client);

        await client.query("COMMIT");

        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The original failure is the one callers handle.
        }

        throw error;
      }
    } catch (error) {
      throw redact(error, this.connectionString);
    } finally {
      client.release();
    }
  }

  private async connect(): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw redact(error, this.connectionString);
    }
  }

  private async rows<T extends QueryResultRow>(client: PoolClient, text: string, values: unknown[]): Promise<T[]> {
    const result = await client.query<T>(text, values);

    return result.rows;
  }

  private async rowsFromPool<T extends QueryResultRow>(text: string, values: unknown[]): Promise<T[]> {
    try {
      const result = await this.pool.query<T>(text, values);

      return result.rows;
    } catch (error) {
      throw redact(error, this.connectionString);
    }
  }
}

function openPool(connectionString: string): Pool {
  try {
    const pool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      application_name: "lameddb",
    });

    pool.on("error", () => {
      // An idle client can drop after PostgreSQL closes it. The next request reports that.
    });

    return pool;
  } catch (error) {
    throw redact(error, connectionString);
  }
}

function redact(error: unknown, connectionString: string): unknown {
  if (error instanceof LamedError) {
    return error;
  }

  if (!(error instanceof Error)) {
    return new LamedError("internal", "The database request failed.");
  }

  const haystack = `${error.message}\n${error.stack ?? ""}`;

  for (const fragment of secretFragments(connectionString)) {
    if (haystack.includes(fragment)) {
      return new LamedError("internal", "The database request failed.");
    }
  }

  return error;
}

function secretFragments(connectionString: string): string[] {
  const fragments = [connectionString];

  try {
    const url = new URL(connectionString);

    if (url.password.length >= 8) {
      fragments.push(decodeURIComponent(url.password));
    }

    if (url.username !== "" && url.password !== "") {
      fragments.push(`${url.username}:${decodeURIComponent(url.password)}`);
    }
  } catch {
    // The whole string is still compared.
  }

  return fragments.filter((fragment) => fragment.length >= 8);
}

function isExpired(storedAt: number, now: number, ttlMs: number): boolean {
  if (now < storedAt) {
    return false;
  }

  return now - storedAt >= ttlMs;
}

function cloneFields(fields: FieldMap): FieldMap {
  const copy: Record<string, FieldType> = {};

  for (const [name, type] of Object.entries(fields)) {
    defineOwn(copy, name, type);
  }

  return copy;
}

function cloneAliases(aliases: AliasMap): AliasMap {
  const copy: Record<string, string> = {};

  for (const [name, target] of Object.entries(aliases)) {
    defineOwn(copy, name, target);
  }

  return copy;
}

function collectionInfo(name: string, fields: FieldMap, aliases: AliasMap): CollectionInfo {
  const copy: CollectionInfo = {
    name,
    fields: cloneFields(fields),
  };

  if (Object.keys(aliases).length > 0) {
    copy.aliases = cloneAliases(aliases);
  }

  return copy;
}

function cloneDocument(data: JsonObject): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(data));

  if (!isPlainData(parsed)) {
    throw new LamedError("invalid_argument", "Record data must be a JSON object.");
  }

  return parsed;
}

function cloneRecord(record: RecordEnvelope): RecordEnvelope {
  return {
    id: record.id,
    version: record.version,
    data: cloneDocument(record.data),
  };
}

function readFields(value: unknown): FieldMap {
  const parsed = readJsonValue(value);

  if (!isPlainData(parsed)) {
    throw new LamedError("internal", "Stored collection fields are unreadable.");
  }

  const fields: Record<string, FieldType> = {};

  for (const [name, type] of Object.entries(parsed)) {
    if (type !== "string" && type !== "integer" && type !== "timestamp") {
      throw new LamedError("internal", "Stored collection fields are unreadable.");
    }

    defineOwn(fields, name, type);
  }

  return fields;
}

function readAliases(value: unknown): AliasMap {
  const parsed = readJsonValue(value);

  if (!isPlainData(parsed)) {
    throw new LamedError("internal", "Stored collection aliases are unreadable.");
  }

  const aliases: Record<string, string> = {};

  for (const [name, target] of Object.entries(parsed)) {
    if (typeof target !== "string") {
      throw new LamedError("internal", "Stored collection aliases are unreadable.");
    }

    defineOwn(aliases, name, target);
  }

  return aliases;
}

function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function readJsonObject(value: unknown): JsonObject {
  const parsed = readJsonValue(value);

  if (!isPlainData(parsed)) {
    throw new LamedError("internal", "Stored record is unreadable.");
  }

  return cloneDocument(parsed);
}

function readJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new LamedError("internal", "Stored JSON is unreadable.");
  }
}

function readInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new LamedError("internal", `Stored ${label} is unreadable.`);
  }

  return parsed;
}

function isPlainData(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
