import { listen } from "./http/server.js";
import { MemoryStore } from "./storage/memory-store.js";
import { idempotencyRetentionFromEnv } from "./validate.js";

const port = readPort(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
const retention = idempotencyRetentionFromEnv(process.env);

const running = await listen({ port, host, store: new MemoryStore(retention) });

console.log(`LamedDB listening on ${running.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close().then(() => {
      process.exit(0);
    });
  });
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
