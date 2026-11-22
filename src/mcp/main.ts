#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./server.js";

const baseUrl = process.env.LAMEDDB_URL?.trim() || "http://127.0.0.1:8080";
// Not trimmed: a key with stray spaces is rejected, not silently repaired.
const apiKey = process.env.LAMEDDB_API_KEY;
const timeoutMs = readTimeout(process.env.LAMEDDB_TIMEOUT_MS);

if (apiKey === undefined || apiKey === "") {
  // stdout is the protocol channel, so diagnostics go to stderr.
  console.error("LAMEDDB_API_KEY is required.");
  process.exit(1);
}

try {
  await createMcpServer({ baseUrl, apiKey, timeoutMs }).connect(new StdioServerTransport());
  console.error("lameddb-mcp ready (stdio)");
} catch (error) {
  console.error(`lameddb-mcp failed to start: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}

function readTimeout(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_TIMEOUT_MS;
  }

  const timeout = Number(value);

  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    console.error(`Invalid LAMEDDB_TIMEOUT_MS "${value.slice(0, 20)}". Expected a whole number from 1 to ${MAX_TIMEOUT_MS}.`);
    process.exit(1);
  }

  return timeout;
}
