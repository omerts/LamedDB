import { Catalog } from "./engine/catalog.js";
import { EngineRegistry, postgresStoreDescriptor } from "./engine/registry.js";
import { Router } from "./engine/router.js";
import { CollectionService } from "./collections/service.js";
import { listen } from "./http/server.js";
import { MemoryStore } from "./storage/memory-store.js";
import { PostgresStore } from "./storage/postgres-store.js";
import { apiKeysFromEnv, databaseUrlFromEnv, idempotencyRetentionFromEnv } from "./validate.js";

const port = readPort(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
const retention = idempotencyRetentionFromEnv(process.env);
const apiKeys = apiKeysFromEnv(process.env);
const databaseUrl = databaseUrlFromEnv(process.env);
const backend = await openBackend(databaseUrl, retention);

try {
  const running = await listen({
    port,
    host,
    apiKeys,
    ...(backend.service !== undefined ? { service: backend.service } : { store: backend.store }),
  });

  console.log(`LamedDB listening on ${running.url}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void running
        .close()
        .then(() => backend.close())
        .then(() => {
          process.exit(0);
        });
    });
  }
} catch (error) {
  await backend.close();

  throw error;
}

interface OpenBackend {
  store?: MemoryStore;
  service?: CollectionService;
  close(): Promise<void>;
}

async function openBackend(
  databaseUrl: string | undefined,
  retention: { idempotencyTtlMs: number; maxIdempotencyKeys: number },
): Promise<OpenBackend> {
  if (databaseUrl === undefined) {
    return {
      store: new MemoryStore(retention),
      close: async () => {},
    };
  }

  let store: PostgresStore | undefined;

  try {
    store = new PostgresStore({
      connectionString: databaseUrl,
      idempotencyTtlMs: retention.idempotencyTtlMs,
      maxIdempotencyKeys: retention.maxIdempotencyKeys,
    });
    await store.migrate();
  } catch {
    if (store !== undefined) {
      try {
        await store.close();
      } catch {
        // The startup message below is the one the operator sees.
      }
    }

    console.error(
      "Could not open the database. Check LAMEDDB_DATABASE_URL and that PostgreSQL is accepting connections.",
    );
    process.exit(1);
  }

  const registry = new EngineRegistry();

  registry.register("postgres", store, postgresStoreDescriptor());

  return {
    service: new CollectionService(new Router(registry, new Catalog(registry, "postgres"))),
    close: () => store.close(),
  };
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 8080;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT "${value}". Expected an integer from 0 to 65535.`);
  }

  return port;
}
