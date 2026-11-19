import { LamedError } from "./errors.js";
import type { FieldMap, FieldType, JsonObject, JsonValue } from "./types.js";

export const LIMITS = {
  maxBodyBytes: 1_048_576,
  maxStringBytes: 65_536,
  maxDeclaredFields: 64,
  maxDepth: 32,
  maxObjectKeys: 256,
  maxArrayItems: 1_024,
} as const;

const COLLECTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELD_TYPES: readonly FieldType[] = ["string", "integer", "timestamp"];

export function parseCollectionName(name: string): string {
  if (COLLECTION_NAME.test(name)) {
    return name;
  }

  throw new LamedError(
    "invalid_argument",
    `Collection name "${preview(name)}" is not allowed. Use a letter, then letters, digits, underscores, or hyphens, up to 63 characters.`,
  );
}

export function parseRecordId(id: string): string {
  if (RECORD_ID.test(id)) {
    return id;
  }

  throw new LamedError(
    "invalid_argument",
    `Record id "${preview(id)}" is not allowed. Use letters, digits, and . _ : -, starting with a letter or digit, up to 128 characters.`,
  );
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

function isCanonicalTimestamp(value: string): boolean {
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

function preview(value: string): string {
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
