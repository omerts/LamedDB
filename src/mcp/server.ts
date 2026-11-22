import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LamedError } from "../errors.js";
import { LamedDB } from "../sdk/client.js";
import { LIMITS, isValidApiKey } from "../validate.js";

export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FILTER_CLAUSES = 10;
const MAX_IN_VALUES = 20;

export interface LamedMcpOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout. Default 10 seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const scalar = z.union([z.string(), z.number().finite(), z.null()]);

const operators = z
  .strictObject({
    eq: scalar,
    ne: scalar,
    gt: scalar,
    gte: scalar,
    lt: scalar,
    lte: scalar,
    prefix: z.string().min(1),
    in: z.array(scalar).min(1).max(MAX_IN_VALUES),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Give at least one operator." });

const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Not a valid field name.");

export const queryRecordsInput = z.strictObject({
  collection: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/, "Use a letter, then letters, digits, _ or -, up to 63 characters."),
  limit: z.number().int().min(1).max(LIMITS.maxListLimit).optional(),
  cursor: z.string().min(1).optional(),
  sort: z.string().regex(/^-?[A-Za-z_][A-Za-z0-9_]{0,63}$/, "Use field or -field.").optional(),
  filter: z
    .record(fieldName, z.union([scalar, operators]))
    .refine((value) => Object.keys(value).length <= MAX_FILTER_CLAUSES, {
      message: `At most ${MAX_FILTER_CLAUSES} fields.`,
    })
    .optional(),
});

export type QueryRecordsInput = z.infer<typeof queryRecordsInput>;

/** Build an MCP server with one tool, `query_records`, that lists records through the LamedDB SDK. */
export function createMcpServer(options: LamedMcpOptions): McpServer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
    throw new Error("baseUrl is required.");
  }

  if (typeof options.apiKey !== "string" || !isValidApiKey(options.apiKey)) {
    throw new Error("apiKey is required and must be printable ASCII with no spaces.");
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive whole number.");
  }

  const baseFetch = options.fetch ?? globalThis.fetch;
  const db = new LamedDB({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    fetch: (input, init) => baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
  const target = describeTarget(options.baseUrl);
  const server = new McpServer({ name: "lameddb", version: "0.0.0" });

  server.registerTool(
    "query_records",
    {
      title: "Query LamedDB records",
      description:
        "List records in a LamedDB collection, one page at a time. Optional limit (1-100), sort (`field` or `-field`), " +
        "filter and cursor. filter maps a field or alias to a value (equality) or to operators " +
        "eq, ne, gt, gte, lt, lte, in, prefix, e.g. {\"amount\":{\"gte\":1000}}. Clauses are ANDed. " +
        "Pass nextCursor back as cursor, with the same filter and sort, for the next page.",
      inputSchema: queryRecordsInput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input: QueryRecordsInput) => {
      try {
        const { collection, ...listOptions } = input;
        const page = await db.collection(collection).list(listOptions);

        return { content: [{ type: "text" as const, text: JSON.stringify(page) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: describeFailure(error, target, timeoutMs) }] };
      }
    },
  );

  return server;
}

/** Turn any failure into a short message. Never includes the API key or a raw stack. */
function describeFailure(error: unknown, target: string, timeoutMs: number): string {
  if (error instanceof LamedError) {
    switch (error.code) {
      case "unauthenticated":
        return "Authentication failed: LAMEDDB_API_KEY was rejected by the server (401).";
      case "not_found":
        return `Not found: ${error.message}`;
      case "invalid_argument":
        return `Invalid request: ${error.message}`;
      default:
        return `LamedDB error (${error.code}): ${error.message}`;
    }
  }

  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Timed out after ${timeoutMs} ms waiting for LamedDB at ${target}.`;
  }

  return `Could not reach LamedDB at ${target}. Check that the server is running and LAMEDDB_URL is right.`;
}

function describeTarget(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "the configured URL";
  }
}
