import { createHash } from "node:crypto";

import { LamedError } from "../errors.js";
import type { ListPosition, RecordFilter, RecordSort } from "../storage/query.js";
import type { CollectionState } from "../storage/store.js";
import type { FieldType, FilterOperator, JsonValue } from "../types.js";
import { isCanonicalTimestamp, isPlainObject, LIMITS, parseRecordId, preview } from "../validate.js";

const OPERATORS: readonly FilterOperator[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "prefix"];
const LIST_OPTIONS = ["limit", "cursor", "sort", "filter"] as const;
const CURSOR_CHARS = /^[A-Za-z0-9_-]+$/;
const INTEGER_TEXT = /^-?(0|[1-9][0-9]*)$/;

export interface ParsedListQuery {
  limit: number;
  filters: RecordFilter[];
  sort: RecordSort;
  /** Stable identity of the filters and sort. A cursor is only valid with the query that made it. */
  queryHash: string;
  after?: ListPosition;
}

/**
 * Turn raw list options (the wire form: strings) into a checked query.
 * Every problem is an `invalid_argument` that names the bad field, operator, or option.
 */
export function parseListQuery(options: unknown, collection: CollectionState): ParsedListQuery {
  if (options !== undefined && !isPlainObject(options)) {
    throw invalid("List options must be an object.");
  }

  const raw = options ?? {};

  for (const key of Reflect.ownKeys(raw)) {
    if (!(LIST_OPTIONS as readonly (string | symbol)[]).includes(key)) {
      throw invalid(`Unknown list option "${typeof key === "string" ? preview(key) : "symbol"}". Expected ${LIST_OPTIONS.join(", ")}.`);
    }
  }

  const limit = parseLimit(raw.limit);
  const sort = parseSort(raw.sort, collection);
  const filters = parseFilters(raw.filter, collection);
  const queryHash = hashQuery(filters, sort);
  const after = parseCursor(raw.cursor, collection, sort, queryHash);

  return { limit, filters, sort, queryHash, ...(after === undefined ? {} : { after }) };
}

/** The cursor for the page that ended at `last`. The sort value is stored so a deleted record cannot lose the place. */
export function encodeCursor(
  collection: CollectionState,
  query: Pick<ParsedListQuery, "sort" | "queryHash">,
  last: { id: string; value: JsonValue },
): string {
  const payload: Record<string, unknown> = {
    v: 1,
    c: collection.name,
    r: collection.revision,
    q: query.queryHash,
    a: last.id,
  };

  if (query.sort.field !== "id") {
    payload.s = last.value;
  }

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return LIMITS.defaultListLimit;
  }

  const bad = invalid(`limit must be a whole number from 1 to ${LIMITS.maxListLimit}.`, "limit");
  let limit: number;

  if (typeof value === "number") {
    limit = value;
  } else if (typeof value === "string" && /^[0-9]{1,9}$/.test(value)) {
    limit = Number(value);
  } else {
    throw bad;
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxListLimit) {
    throw bad;
  }

  return limit;
}

interface ResolvedField {
  field: string;
  type: FieldType;
}

function resolveField(name: string, collection: CollectionState): ResolvedField | undefined {
  if (name === "id") {
    return { field: "id", type: "string" };
  }

  const declared = Object.prototype.hasOwnProperty.call(collection.fields, name) ? collection.fields[name] : undefined;

  if (declared !== undefined) {
    return { field: name, type: declared };
  }

  const aliases = collection.aliases ?? {};
  const target = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined;
  const type = target === undefined ? undefined : collection.fields[target];

  return target === undefined || type === undefined ? undefined : { field: target, type };
}

function knownNames(collection: CollectionState): string {
  const names = ["id", ...Object.keys(collection.fields), ...Object.keys(collection.aliases ?? {})];

  return names.map((name) => `"${name}"`).join(", ");
}

function parseSort(value: unknown, collection: CollectionState): RecordSort {
  if (value === undefined) {
    return { field: "id", direction: "asc" };
  }

  if (typeof value !== "string" || value.length === 0) {
    throw invalid('sort must be a field name, or "-" and a field name for descending.', "sort");
  }

  const direction = value.startsWith("-") ? "desc" : "asc";
  const name = direction === "desc" ? value.slice(1) : value;
  const resolved = resolveField(name, collection);

  if (resolved === undefined) {
    throw invalid(`Cannot sort by unknown field "${preview(name)}". Known fields: ${knownNames(collection)}.`, "sort");
  }

  if (resolved.field !== "id" && resolved.type === "string") {
    throw invalid(`Cannot sort by string field "${preview(name)}". Sort by id, an integer field, or a timestamp field.`, "sort");
  }

  return { field: resolved.field, direction };
}

function parseFilters(value: unknown, collection: CollectionState): RecordFilter[] {
  if (value === undefined) {
    return [];
  }

  if (!isPlainObject(value)) {
    throw invalid("filter must be an object of field to value or operators.", "filter");
  }

  const clauses: { name: string; op: string; raw: unknown }[] = [];

  for (const name of Object.keys(value)) {
    const entry = value[name];

    if (isPlainObject(entry)) {
      if (Object.keys(entry).length === 0) {
        throw invalid(
          `Filter "${preview(name)}" has no operator. Use a value, or an object such as { gte: 1 }. Operators: ${OPERATORS.join(", ")}.`,
          "filter",
        );
      }

      for (const op of Object.keys(entry)) {
        clauses.push({ name, op, raw: entry[op] });
      }
    } else {
      clauses.push({ name, op: "eq", raw: entry });
    }
  }

  if (clauses.length > LIMITS.maxFilterClauses) {
    throw invalid(`A list request can have at most ${LIMITS.maxFilterClauses} filter clauses, got ${clauses.length}.`, "filter");
  }

  const seen = new Set<string>();
  const filters: RecordFilter[] = [];

  for (const clause of clauses) {
    const shown = `${preview(clause.name)}[${preview(clause.op)}]`;

    if (!(OPERATORS as readonly string[]).includes(clause.op)) {
      throw invalid(`Unknown filter operator "${preview(clause.op)}" on "${preview(clause.name)}". Operators: ${OPERATORS.join(", ")}.`, "filter");
    }

    const resolved = resolveField(clause.name, collection);

    if (resolved === undefined) {
      throw invalid(`Cannot filter by unknown field "${preview(clause.name)}". Known fields: ${knownNames(collection)}.`, "filter");
    }

    const op = clause.op as FilterOperator;
    const key = `${resolved.field}\u0000${op}`;

    if (seen.has(key)) {
      throw invalid(`Filter ${shown} is repeated. Each field can be used once per operator (aliases count as their field).`, "filter");
    }

    seen.add(key);
    filters.push({ field: resolved.field, op, value: parseFilterValue(clause.raw, op, resolved, shown) });
  }

  return filters;
}

function parseFilterValue(
  raw: unknown,
  op: FilterOperator,
  resolved: ResolvedField,
  shown: string,
): JsonValue | readonly JsonValue[] {
  const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;

  if (typeof text !== "string") {
    throw invalid(`Filter ${shown} needs a string value.`, "filter");
  }

  if (op === "prefix") {
    if (resolved.type !== "string") {
      throw invalid(`Operator "prefix" only works on string fields, but "${resolved.field}" is ${resolved.type}.`, "filter");
    }

    if (text.length === 0) {
      throw invalid(`Filter ${shown} needs a non-empty prefix.`, "filter");
    }

    return text;
  }

  if (op === "in") {
    const parts = text.split(",");

    if (parts.length > LIMITS.maxInValues) {
      throw invalid(`Filter ${shown} needs 1 to ${LIMITS.maxInValues} comma-separated values (an empty value is one empty string).`, "filter");
    }

    return parts.map((part) => parseScalar(part, resolved, shown));
  }

  const value = parseScalar(text, resolved, shown);

  if (value === null && op !== "eq" && op !== "ne") {
    throw invalid(`Operator "${op}" cannot compare with null (filter ${shown}).`, "filter");
  }

  return value;
}

function parseScalar(text: string, resolved: ResolvedField, shown: string): JsonValue {
  if (text === "null") {
    return null;
  }

  if (resolved.type === "string") {
    return text;
  }

  if (resolved.type === "integer") {
    const value = Number(text);

    if (INTEGER_TEXT.test(text) && Number.isSafeInteger(value)) {
      return value;
    }

    throw invalid(`Filter ${shown} needs an integer in the safe integer range, or null, for field "${resolved.field}".`, "filter");
  }

  if (isCanonicalTimestamp(text)) {
    return text;
  }

  throw invalid(`Filter ${shown} needs a UTC timestamp such as "2026-11-19T08:15:00.000Z", or null, for field "${resolved.field}".`, "filter");
}

function hashQuery(filters: readonly RecordFilter[], sort: RecordSort): string {
  const clauses = filters
    .map((filter) => [filter.field, filter.op, filter.value] as const)
    .sort((a, b) => (`${a[0]}\u0000${a[1]}` < `${b[0]}\u0000${b[1]}` ? -1 : 1));

  return createHash("sha256")
    .update(JSON.stringify([sort.field, sort.direction, clauses]))
    .digest("hex")
    .slice(0, 16);
}

function parseCursor(
  value: unknown,
  collection: CollectionState,
  sort: RecordSort,
  queryHash: string,
): ListPosition | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.maxCursorLength || !CURSOR_CHARS.test(value)) {
    throw invalid("cursor is not valid. Use the nextCursor from a previous page.", "cursor");
  }

  const payload = decodePayload(value);
  const id = typeof payload.a === "string" ? safeRecordId(payload.a) : undefined;

  if (payload.v !== 1 || typeof payload.c !== "string" || !Number.isSafeInteger(payload.r) || typeof payload.q !== "string" || id === undefined) {
    throw invalid("cursor is not valid. Use the nextCursor from a previous page.", "cursor");
  }

  if (payload.c !== collection.name || payload.r !== collection.revision) {
    throw invalid("cursor was created for a different collection.", "cursor");
  }

  if (payload.q !== queryHash) {
    throw invalid("cursor was created with different filter or sort settings. Start again without a cursor.", "cursor");
  }

  if (sort.field === "id") {
    return { id, value: id };
  }

  const sortValue = payload.s;
  const type = collection.fields[sort.field];
  const fits =
    sortValue === null ||
    (type === "integer" && typeof sortValue === "number" && Number.isSafeInteger(sortValue)) ||
    (type === "timestamp" && typeof sortValue === "string" && isCanonicalTimestamp(sortValue));

  if (!fits) {
    throw invalid("cursor is not valid. Use the nextCursor from a previous page.", "cursor");
  }

  return { id, value: sortValue as JsonValue };
}

function decodePayload(cursor: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

    if (isPlainObject(parsed)) {
      return parsed;
    }
  } catch {
    // Falls through to the error below.
  }

  throw invalid("cursor is not valid. Use the nextCursor from a previous page.", "cursor");
}

function safeRecordId(id: string): string | undefined {
  try {
    return parseRecordId(id);
  } catch {
    return undefined;
  }
}

function invalid(message: string, parameter?: string): LamedError {
  return new LamedError("invalid_argument", message, parameter === undefined ? undefined : { parameter });
}
