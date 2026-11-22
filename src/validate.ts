import { LamedError } from "./errors.js";
import type { AliasMap, FieldMap, FieldType, JsonObject, JsonValue } from "./types.js";

export const LIMITS = {
  maxBodyBytes: 1_048_576,
  maxStringBytes: 65_536,
  maxDeclaredFields: 64,
  maxDepth: 32,
  maxObjectKeys: 256,
  maxArrayItems: 1_024,
  maxIdempotencyKeyLength: 255,
  /** Default lifetime of a stored idempotency key. 24 hours. */
  idempotencyTtlMs: 86_400_000,
  /** Default maximum of live keys kept for one collection. */
  maxIdempotencyKeysPerCollection: 10_000,
  maxAliases: 64,
  defaultListLimit: 50,
  maxListLimit: 100,
  maxCursorLength: 512,
  maxFilterClauses: 10,
  maxInValues: 20,
} as const;

const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELD_TYPES: readonly FieldType[] = ["string", "integer", "timestamp"];
const PRINTABLE_ASCII = /^[\u0020-\u007E]+$/;

export function parseCollectionName(name: unknown): string {
  if (typeof name !== "string") {
    throw new LamedError("invalid_argument", "Collection name must be a string.", {
      parameter: "name",
    });
  }

  if (COLLECTION_NAME.test(name)) {
    return name;
  }

  throw new LamedError(
    "invalid_argument",
    `Collection name "${preview(name)}" is not allowed. Use a letter, then letters, digits, underscores, or hyphens, up to 63 characters.`,
  );
}

export function parseRecordId(id: unknown): string {
  if (typeof id !== "string") {
    throw new LamedError("invalid_argument", "Record id must be a string.", {
      parameter: "id",
    });
  }

  if (RECORD_ID.test(id)) {
    return id;
  }

  throw new LamedError(
    "invalid_argument",
    `Record id "${preview(id)}" is not allowed. Use letters, digits, and . _ : -, starting with a letter or digit, up to 128 characters.`,
  );
}

export function parseIdempotencyKey(key: unknown): string {
  if (typeof key !== "string") {
    throw new LamedError("invalid_argument", "Idempotency-Key must be a string.", {
      parameter: "idempotencyKey",
    });
  }

  if (key !== key.trim()) {
    throw new LamedError(
      "invalid_argument",
      "Idempotency-Key must not have leading or trailing whitespace.",
      { parameter: "idempotencyKey" },
    );
  }

  if (key.length < 1 || key.length > LIMITS.maxIdempotencyKeyLength || !PRINTABLE_ASCII.test(key)) {
    throw new LamedError(
      "invalid_argument",
      `Idempotency-Key must be 1-${LIMITS.maxIdempotencyKeyLength} printable ASCII characters.`,
      { parameter: "idempotencyKey" },
    );
  }

  return key;
}

/** Runtime check for put options. Unknown options are rejected, not ignored. */
export function parsePutOptions(options: unknown): {
  createOnly: boolean;
  idempotencyKey?: string;
  ifVersion?: number;
} {
  if (options === undefined) {
    return { createOnly: false };
  }

  if (!isPlainObject(options)) {
    throw new LamedError("invalid_argument", "Put options must be an object.");
  }

  for (const key of Reflect.ownKeys(options)) {
    if (key !== "createOnly" && key !== "idempotencyKey" && key !== "ifVersion") {
      throw new LamedError("invalid_argument", `Unknown put option "${optionKeyName(key)}".`);
    }
  }

  const createOnly = options.createOnly;

  if (createOnly !== undefined && typeof createOnly !== "boolean") {
    throw new LamedError("invalid_argument", 'Option "createOnly" must be a boolean.');
  }

  const ifVersion = parseIfVersion(options.ifVersion);

  if (createOnly === true && ifVersion !== undefined) {
    throw new LamedError("invalid_argument", "If-Match and If-None-Match cannot be used together.");
  }

  const idempotencyKey =
    options.idempotencyKey === undefined ? undefined : parseIdempotencyKey(options.idempotencyKey);

  return {
    createOnly: createOnly === true,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(ifVersion !== undefined ? { ifVersion } : {}),
  };
}

const STORE_OPTIONS = new Set(["now", "idempotencyTtlMs", "maxIdempotencyKeys"]);

export interface MemoryStoreRetention {
  now: () => number;
  idempotencyTtlMs: number;
  maxIdempotencyKeys: number;
}

/**
 * Runtime check for MemoryStore options. Unknown options are rejected, not ignored.
 * Omitted retention settings use the defaults in `LIMITS`.
 */
export function parseMemoryStoreOptions(options: unknown): MemoryStoreRetention {
  if (options === undefined) {
    return defaultRetention(Date.now);
  }

  if (!isPlainObject(options)) {
    throw new LamedError("invalid_argument", "MemoryStore options must be an object.");
  }

  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !STORE_OPTIONS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown store option "${optionKeyName(key)}".`);
    }
  }

  const now = options.now;

  if (now !== undefined && typeof now !== "function") {
    throw new LamedError("invalid_argument", "Clock must be a function.", { parameter: "now" });
  }

  return {
    now: typeof now === "function" ? (now as () => number) : Date.now,
    idempotencyTtlMs: parsePositiveInteger(
      options.idempotencyTtlMs,
      "idempotencyTtlMs",
      LIMITS.idempotencyTtlMs,
    ),
    maxIdempotencyKeys: parsePositiveInteger(
      options.maxIdempotencyKeys,
      "maxIdempotencyKeys",
      LIMITS.maxIdempotencyKeysPerCollection,
    ),
  };
}

/** Read the server's idempotency TTL and cap. Empty values use the defaults. */
export function idempotencyRetentionFromEnv(env: {
  IDEMPOTENCY_TTL_MS?: unknown;
  IDEMPOTENCY_MAX_KEYS?: unknown;
}): Pick<MemoryStoreRetention, "idempotencyTtlMs" | "maxIdempotencyKeys"> {
  if (env === null || typeof env !== "object") {
    throw new LamedError("invalid_argument", "Environment must be an object.");
  }

  return {
    idempotencyTtlMs: parsePositiveInteger(
      env.IDEMPOTENCY_TTL_MS,
      "IDEMPOTENCY_TTL_MS",
      LIMITS.idempotencyTtlMs,
    ),
    maxIdempotencyKeys: parsePositiveInteger(
      env.IDEMPOTENCY_MAX_KEYS,
      "IDEMPOTENCY_MAX_KEYS",
      LIMITS.maxIdempotencyKeysPerCollection,
    ),
  };
}

const API_KEY_REQUIRED =
  "At least one API key is required. The server refuses to start without apiKeys.";

const API_KEY_CHARACTERS =
  "API keys must be non-empty printable ASCII strings with no spaces or control characters.";

/** Printable ASCII, excluding space and control characters. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

/** True only for a non-empty printable ASCII key, with no spaces or control characters. */
export function isValidApiKey(key: string): boolean {
  return typeof key === "string" && API_KEY_PATTERN.test(key);
}

/**
 * Runtime check for the keys `listen` accepts.
 * An empty list is rejected, so there is no way to start without authentication.
 */
export function parseApiKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LamedError("invalid_argument", API_KEY_REQUIRED);
  }

  const keys: string[] = [];

  for (const key of value) {
    if (typeof key !== "string" || !isValidApiKey(key)) {
      throw new LamedError("invalid_argument", API_KEY_CHARACTERS);
    }

    keys.push(key);
  }

  return keys;
}

/** Read `LAMEDDB_API_KEYS` as a comma-separated list. Missing and blank values fail. */
export function apiKeysFromEnv(env: { LAMEDDB_API_KEYS?: unknown }): readonly string[] {
  if (env === null || typeof env !== "object") {
    throw new LamedError("invalid_argument", "Environment must be an object.");
  }

  const raw = env.LAMEDDB_API_KEYS;

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new LamedError(
      "invalid_argument",
      "LAMEDDB_API_KEYS is required. Set it to one or more comma-separated API keys. The server refuses to start without them.",
    );
  }

  const keys = raw.split(",").map((part) => part.trim());

  if (keys.some((key) => key.length === 0)) {
    throw new LamedError(
      "invalid_argument",
      "LAMEDDB_API_KEYS contains an empty key. Pass a comma-separated list of non-empty keys.",
    );
  }

  return parseApiKeys(keys);
}

function defaultRetention(now: () => number): MemoryStoreRetention {
  return {
    now,
    idempotencyTtlMs: LIMITS.idempotencyTtlMs,
    maxIdempotencyKeys: LIMITS.maxIdempotencyKeysPerCollection,
  };
}

function parsePositiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = typeof value === "string" ? strictInteger(value) : value;

  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new LamedError("invalid_argument", `${label} must be a positive integer.`, {
      parameter: label,
    });
  }

  return parsed;
}

function strictInteger(value: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    return undefined;
  }

  return parsed;
}

function parseIfVersion(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LamedError("invalid_argument", "ifVersion must be a non-negative safe integer.");
  }

  return value;
}

export function parseFieldDeclarations(fields: unknown): FieldMap {
  if (fields === undefined) {
    return {};
  }

  if (!isPlainObject(fields)) {
    throw new LamedError("invalid_argument", 'Property "fields" must be an object.');
  }

  const names = Object.keys(fields);

  if (names.length > LIMITS.maxDeclaredFields) {
    throw new LamedError(
      "invalid_argument",
      `A collection can declare at most ${LIMITS.maxDeclaredFields} fields.`,
    );
  }

  const parsed: Record<string, FieldType> = {};

  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      throw new LamedError(
        "invalid_argument",
        `Field name "${preview(name)}" is not allowed. Use a letter or underscore, then letters, digits, or underscores, up to 64 characters.`,
      );
    }

    const type = fields[name];

    if (typeof type !== "string" || !isFieldType(type)) {
      throw new LamedError(
        "invalid_argument",
        `Field "${name}" has unsupported type ${JSON.stringify(type)}. Expected "string", "integer", or "timestamp".`,
        { field: name },
      );
    }

    defineOwn(parsed, name, type);
  }

  return parsed;
}

/**
 * Check alias declarations against the declared fields.
 * An alias is a friendlier name for one declared field. It cannot reuse a declared
 * field name or `id`, and it must point at a declared field (not at another alias).
 */
export function parseAliasDeclarations(aliases: unknown, fields: FieldMap): AliasMap {
  if (aliases === undefined) {
    return {};
  }

  if (!isPlainObject(aliases)) {
    throw new LamedError("invalid_argument", 'Property "aliases" must be an object.');
  }

  const names = Object.keys(aliases);

  if (names.length > LIMITS.maxAliases) {
    throw new LamedError(
      "invalid_argument",
      `A collection can declare at most ${LIMITS.maxAliases} aliases.`,
    );
  }

  const parsed: Record<string, string> = {};

  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      throw new LamedError(
        "invalid_argument",
        `Alias name "${preview(name)}" is not allowed. Use a letter or underscore, then letters, digits, or underscores, up to 64 characters.`,
        { alias: name },
      );
    }

    if (name === "id" || Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new LamedError(
        "invalid_argument",
        `Alias "${name}" collides with ${name === "id" ? 'the reserved name "id"' : "a declared field"}.`,
        { alias: name },
      );
    }

    const target = aliases[name];

    if (typeof target !== "string" || !Object.prototype.hasOwnProperty.call(fields, target)) {
      throw new LamedError(
        "invalid_argument",
        `Alias "${name}" must point at a declared field. Declared fields: ${listNames(Object.keys(fields))}.`,
        { alias: name },
      );
    }

    defineOwn(parsed, name, target);
  }

  return parsed;
}

function listNames(names: readonly string[]): string {
  return names.length === 0 ? "(none)" : names.map((name) => `"${name}"`).join(", ");
}

/**
 * Copy a JSON document and check declared field types.
 * Null is a stored value. Omitted fields are left missing. Extra fields are kept.
 */
export function validateDocument(input: unknown, fields: FieldMap): JsonObject {
  if (!isPlainObject(input)) {
    throw new LamedError("invalid_argument", "Record data must be a JSON object.");
  }

  const data = copyJsonObject(input, "$", 0);

  for (const [name, type] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(data, name)) {
      continue;
    }

    assertFieldValue(name, type, data[name]);
  }

  return data;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function copyJsonObject(input: Record<string, unknown>, path: string, depth: number): JsonObject {
  const names = Object.keys(input);

  if (names.length > LIMITS.maxObjectKeys) {
    throw new LamedError(
      "invalid_argument",
      `Object at ${path} has ${names.length} keys. The limit is ${LIMITS.maxObjectKeys}.`,
    );
  }

  const copy: JsonObject = {};

  for (const name of names) {
    defineOwn(copy, name, copyJsonValue(input[name], joinPath(path, name), depth + 1));
  }

  return copy;
}

function copyJsonValue(value: unknown, path: string, depth: number): JsonValue {
  if (depth > LIMITS.maxDepth) {
    throw new LamedError("invalid_argument", `Value at ${path} is nested too deeply.`);
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > LIMITS.maxStringBytes) {
      throw new LamedError(
        "invalid_argument",
        `String at ${path} exceeds ${LIMITS.maxStringBytes} bytes.`,
      );
    }

    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LamedError("invalid_argument", `Number at ${path} must be finite.`);
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArrayItems) {
      throw new LamedError(
        "invalid_argument",
        `Array at ${path} has ${value.length} items. The limit is ${LIMITS.maxArrayItems}.`,
      );
    }

    return value.map((item, index) => copyJsonValue(item, `${path}[${index}]`, depth + 1));
  }

  if (isPlainObject(value)) {
    return copyJsonObject(value, path, depth);
  }

  throw new LamedError("invalid_argument", `Value at ${path} is not valid JSON.`);
}

function assertFieldValue(name: string, type: FieldType, value: JsonValue | undefined): void {
  if (value === null) {
    return;
  }

  if (type === "string") {
    if (typeof value === "string") {
      return;
    }

    throw fieldTypeError(name, type, "must be a string or null.");
  }

  if (type === "integer") {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return;
    }

    throw fieldTypeError(name, type, "must be an integer in the safe integer range, or null.");
  }

  if (typeof value === "string" && isCanonicalTimestamp(value)) {
    return;
  }

  throw fieldTypeError(
    name,
    type,
    'must be a UTC timestamp with millisecond precision, such as "2026-11-19T08:15:00.000Z", or null.',
  );
}

function fieldTypeError(name: string, type: FieldType, requirement: string): LamedError {
  return new LamedError("invalid_argument", `Field "${name}" ${requirement}`, {
    field: name,
    expected: type,
  });
}

export function isCanonicalTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value)) {
    return false;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return parsed.toISOString() === value;
}

function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

function joinPath(parent: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return `${parent}.${key}`;
  }

  return `${parent}[${JSON.stringify(key)}]`;
}

function optionKeyName(key: string | symbol): string {
  if (typeof key === "string") {
    return preview(key);
  }

  return preview(key.description ?? "symbol");
}

export function preview(value: string): string {
  const flat = value.replace(/[\u0000-\u001F\u007F]/g, " ");

  if (flat.length <= 80) {
    return flat;
  }

  return `${flat.slice(0, 77)}...`;
}

function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
