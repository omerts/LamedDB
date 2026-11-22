import type { FilterOperator, JsonObject, JsonValue, RecordEnvelope } from "../types.js";

/** A clause after the service has resolved aliases and parsed the value by the field's type. */
export interface RecordFilter {
  /** A declared field name, or `id`. Never an alias. */
  field: string;
  op: FilterOperator;
  /** An array for `in`. `null` means "null or missing". */
  value: JsonValue | readonly JsonValue[];
}

export interface RecordSort {
  /** `id`, or a declared integer or timestamp field. */
  field: string;
  direction: "asc" | "desc";
}

/** The last record of the previous page. `value` is its sort value, `null` when missing. */
export interface ListPosition {
  id: string;
  value: JsonValue;
}

export function fieldValue(record: { id: string; data: JsonObject }, field: string): JsonValue | undefined {
  return field === "id" ? record.id : record.data[field];
}

export function matchesFilters(record: RecordEnvelope, filters: readonly RecordFilter[]): boolean {
  return filters.every((filter) => matchesFilter(fieldValue(record, filter.field), filter));
}

function matchesFilter(raw: JsonValue | undefined, filter: RecordFilter): boolean {
  const actual = raw === undefined ? null : raw;
  const wanted = filter.value;

  switch (filter.op) {
    case "eq":
      return actual === wanted;
    case "ne":
      return actual !== wanted;
    case "in":
      return (wanted as readonly JsonValue[]).includes(actual);
    case "prefix":
      return typeof actual === "string" && typeof wanted === "string" && actual.startsWith(wanted);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (actual === null || typeof actual !== typeof wanted) {
        return false;
      }

      const order = compareScalar(actual, wanted as JsonValue);

      if (filter.op === "gt") {
        return order > 0;
      }

      if (filter.op === "gte") {
        return order >= 0;
      }

      return filter.op === "lt" ? order < 0 : order <= 0;
    }
  }
}

/** Null (or missing) sorts before every other value. Numbers and strings compare naturally. */
export function compareScalar(a: JsonValue | undefined, b: JsonValue | undefined): number {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;

  if (left === right) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  return (left as string | number) < (right as string | number) ? -1 : 1;
}

/** Sort order: the sort field in its direction, then ascending id. */
export function compareRecords(a: RecordEnvelope, b: RecordEnvelope, sort: RecordSort): number {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byValue = compareScalar(fieldValue(a, sort.field), fieldValue(b, sort.field)) * sign;

  if (byValue !== 0) {
    return byValue;
  }

  return compareScalar(a.id, b.id);
}

/** True when the record comes strictly after the position in the sort order. */
export function isAfter(record: RecordEnvelope, position: ListPosition, sort: RecordSort): boolean {
  const sign = sort.direction === "asc" ? 1 : -1;
  const byValue = compareScalar(fieldValue(record, sort.field), position.value) * sign;

  if (byValue !== 0) {
    return byValue > 0;
  }

  return compareScalar(record.id, position.id) > 0;
}
