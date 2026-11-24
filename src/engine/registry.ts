import { LamedError } from "../errors.js";
import type { Store } from "../storage/store.js";
import type { FieldType } from "../types.js";
import { isPlainObject, preview } from "../validate.js";

/**
 * Logical operations an engine can serve.
 * A later engine is added by registration. It picks from this list.
 */
export const ENGINE_OPERATIONS = [
  "createCollection",
  "getCollection",
  "deleteCollection",
  "putRecord",
  "getRecord",
  "deleteRecord",
  "listRecords",
] as const;

export type EngineOperation = (typeof ENGINE_OPERATIONS)[number];

/** `write-authority` may accept mutations. `derived-read` serves a rebuildable representation. */
export const ENGINE_ROLES = ["write-authority", "derived-read"] as const;

export type EngineRole = (typeof ENGINE_ROLES)[number];

export const ENGINE_EXACTNESS = ["exact", "approximate"] as const;

export type EngineExactness = (typeof ENGINE_EXACTNESS)[number];

/** `none` keeps nothing after the process exits. `durable` survives a restart. */
export const ENGINE_RECOVERY = ["none", "durable"] as const;

export type EngineRecovery = (typeof ENGINE_RECOVERY)[number];

/** What one call reads. `per-call` is one consistent snapshot for that call and no state after it. */
export const ENGINE_SNAPSHOTS = ["per-call"] as const;

export type EngineSnapshot = (typeof ENGINE_SNAPSHOTS)[number];

const ENGINE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;
const ENGINE_KIND = /^[a-z][a-z0-9-]{0,62}$/;
const LABEL = /^[\u0021-\u007E](?:[\u0020-\u007E]{0,62}[\u0021-\u007E])?$/;
const LABEL_MAX = 64;

const DESCRIPTOR_FIELDS = new Set([
  "kind",
  "roles",
  "operations",
  "fieldTypes",
  "exactness",
  "ordering",
  "snapshot",
  "recovery",
  "region",
  "resourceProfile",
]);

/**
 * What a registered engine can do. The registry copies this on the way in
 * and returns a fresh copy from `get` and `list`.
 */
export interface EngineDescriptor {
  /** Adapter family, such as `memory` or `postgres`. */
  kind: string;
  /** At least one of `write-authority` and `derived-read`. */
  roles: readonly EngineRole[];
  /** Logical operations this engine serves, from `ENGINE_OPERATIONS`. */
  operations: readonly EngineOperation[];
  /** Declared field types this engine can store and compare. */
  fieldTypes: readonly FieldType[];
  exactness: EngineExactness;
  /** Whether `listRecords` honors the requested sort and the ascending id tie-breaker. */
  ordering: boolean;
  snapshot: EngineSnapshot;
  recovery: EngineRecovery;
  /** Optional placement label, such as a region name. */
  region?: string;
  /** Optional capacity label, such as a pool size. */
  resourceProfile?: string;
}

/** One registered engine. `descriptor` is a copy the caller may mutate. */
export interface RegisteredEngine {
  id: string;
  store: Store;
  descriptor: EngineDescriptor;
}

interface StoredEngine {
  id: string;
  store: Store;
  descriptor: EngineDescriptor;
}

/**
 * In-memory registry of engine instances and their capability descriptors.
 * `get` returns `undefined` when the id is not registered. It never substitutes another engine.
 */
export class EngineRegistry {
  private readonly engines = new Map<string, StoredEngine>();

  register(id: string, store: Store, descriptor: EngineDescriptor): void {
    const engineId = parseEngineId(id);
    const storedDescriptor = parseEngineDescriptor(descriptor);
    const engineStore = parseEngineStore(store, storedDescriptor.operations);

    if (this.engines.has(engineId)) {
      throw new LamedError("invalid_argument", `Engine "${engineId}" is already registered.`, {
        id: engineId,
      });
    }

    this.engines.set(engineId, {
      id: engineId,
      store: engineStore,
      descriptor: storedDescriptor,
    });
  }

  /**
   * The engine registered under `id`, or `undefined` when there is none.
   * A missing id is not filled in with a default engine.
   */
  get(id: string): RegisteredEngine | undefined {
    if (typeof id !== "string") {
      throw new LamedError("invalid_argument", "Engine id must be a string.", { parameter: "id" });
    }

    const stored = this.engines.get(id);

    if (!stored) {
      return undefined;
    }

    return expose(stored);
  }

  /** Registered engines in registration order. Each descriptor is its own copy. */
  list(): RegisteredEngine[] {
    return [...this.engines.values()].map(expose);
  }
}

/**
 * Honest descriptor for a `MemoryStore`.
 * It is the write authority for every current operation, exact and ordered,
 * read one snapshot per call, and it keeps nothing after the process exits.
 * It is not a derived read path: those are rebuilt from a write authority.
 */
export function memoryStoreDescriptor(): EngineDescriptor {
  return {
    kind: "memory",
    roles: ["write-authority"],
    operations: [...ENGINE_OPERATIONS],
    fieldTypes: ["string", "integer", "timestamp"],
    exactness: "exact",
    ordering: true,
    snapshot: "per-call",
    recovery: "none",
  };
}

/** Engine ids follow the same shape as collection names. */
export function parseEngineId(id: unknown): string {
  if (typeof id !== "string") {
    throw new LamedError("invalid_argument", "Engine id must be a string.", { parameter: "id" });
  }

  if (id.trim() === "") {
    throw new LamedError("invalid_argument", "Engine id must not be empty.", { parameter: "id" });
  }

  if (ENGINE_ID.test(id)) {
    return id;
  }

  throw new LamedError(
    "invalid_argument",
    `Engine id "${preview(id)}" is not allowed. Use a letter, then letters, digits, underscores, or hyphens, up to 63 characters.`,
    { parameter: "id" },
  );
}

function expose(stored: StoredEngine): RegisteredEngine {
  return {
    id: stored.id,
    store: stored.store,
    descriptor: mutableDescriptor(stored.descriptor),
  };
}

function parseEngineDescriptor(descriptor: unknown): EngineDescriptor {
  if (!isPlainObject(descriptor)) {
    throw new LamedError("invalid_argument", "Engine descriptor must be an object.");
  }

  rejectUnknownFields(descriptor);

  const parsed: EngineDescriptor = {
    kind: parseKind(descriptor.kind),
    roles: parseRoles(descriptor.roles),
    operations: parseOperations(descriptor.operations),
    fieldTypes: parseFieldTypes(descriptor.fieldTypes),
    exactness: parseChoice(descriptor.exactness, ENGINE_EXACTNESS, "exactness"),
    ordering: parseOrdering(descriptor.ordering),
    snapshot: parseChoice(descriptor.snapshot, ENGINE_SNAPSHOTS, "snapshot"),
    recovery: parseChoice(descriptor.recovery, ENGINE_RECOVERY, "recovery"),
  };

  const region = parseLabel(descriptor.region, "region");
  const resourceProfile = parseLabel(descriptor.resourceProfile, "resourceProfile");

  if (region !== undefined) {
    parsed.region = region;
  }

  if (resourceProfile !== undefined) {
    parsed.resourceProfile = resourceProfile;
  }

  return Object.freeze(parsed);
}

function rejectUnknownFields(descriptor: Record<string, unknown>): void {
  for (const key of Reflect.ownKeys(descriptor)) {
    if (typeof key !== "string" || !DESCRIPTOR_FIELDS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown descriptor field "${fieldName(key)}".`);
    }
  }
}

function parseKind(kind: unknown): string {
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new LamedError("invalid_argument", "Engine kind must be a non-empty string.", {
      parameter: "kind",
    });
  }

  if (ENGINE_KIND.test(kind)) {
    return kind;
  }

  throw new LamedError(
    "invalid_argument",
    `Engine kind "${preview(kind)}" is not allowed. Use a lowercase letter, then lowercase letters, digits, or hyphens, up to 63 characters.`,
    { parameter: "kind" },
  );
}

function parseRoles(roles: unknown): readonly EngineRole[] {
  const values = parseStringList(roles, "roles");

  if (values.length === 0) {
    throw new LamedError("invalid_argument", "Descriptor must include at least one role.", {
      parameter: "roles",
    });
  }

  const parsed: EngineRole[] = [];

  for (const role of values) {
    if (!isListed(role, ENGINE_ROLES)) {
      throw new LamedError(
        "invalid_argument",
        `Unknown role "${preview(role)}". Expected "write-authority" or "derived-read".`,
        { parameter: "roles" },
      );
    }

    if (parsed.includes(role)) {
      throw new LamedError("invalid_argument", `Role "${role}" is listed more than once.`, {
        parameter: "roles",
      });
    }

    parsed.push(role);
  }

  return Object.freeze(parsed);
}

function parseOperations(operations: unknown): readonly EngineOperation[] {
  const values = parseStringList(operations, "operations");
  const parsed: EngineOperation[] = [];

  for (const operation of values) {
    if (!isListed(operation, ENGINE_OPERATIONS)) {
      throw new LamedError(
        "invalid_argument",
        `Unknown operation "${preview(operation)}". Expected one of ${listNames(ENGINE_OPERATIONS)}.`,
        { parameter: "operations" },
      );
    }

    if (parsed.includes(operation)) {
      throw new LamedError("invalid_argument", `Operation "${operation}" is listed more than once.`, {
        parameter: "operations",
      });
    }

    parsed.push(operation);
  }

  return Object.freeze(parsed);
}

function parseFieldTypes(fieldTypes: unknown): readonly FieldType[] {
  const values = parseStringList(fieldTypes, "fieldTypes");
  const allowed: readonly FieldType[] = ["string", "integer", "timestamp"];
  const parsed: FieldType[] = [];

  for (const fieldType of values) {
    if (!isListed(fieldType, allowed)) {
      throw new LamedError(
        "invalid_argument",
        `Unknown field type "${preview(fieldType)}". Expected "string", "integer", or "timestamp".`,
        { parameter: "fieldTypes" },
      );
    }

    if (parsed.includes(fieldType)) {
      throw new LamedError("invalid_argument", `Field type "${fieldType}" is listed more than once.`, {
        parameter: "fieldTypes",
      });
    }

    parsed.push(fieldType);
  }

  return Object.freeze(parsed);
}

function parseChoice<T extends string>(value: unknown, allowed: readonly T[], parameter: string): T {
  if (typeof value !== "string" || !isListed(value, allowed)) {
    throw new LamedError(
      "invalid_argument",
      `${parameter} must be one of ${listNames(allowed)}.`,
      { parameter },
    );
  }

  return value;
}

function parseOrdering(ordering: unknown): boolean {
  if (typeof ordering !== "boolean") {
    throw new LamedError("invalid_argument", "ordering must be a boolean.", { parameter: "ordering" });
  }

  return ordering;
}

function parseLabel(value: unknown, parameter: "region" | "resourceProfile"): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new LamedError("invalid_argument", `${parameter} must be a string.`, { parameter });
  }

  if (value.length < 1 || value.length > LABEL_MAX || !LABEL.test(value)) {
    throw new LamedError(
      "invalid_argument",
      `${parameter} must be 1-${LABEL_MAX} printable ASCII characters with no leading or trailing whitespace.`,
      { parameter },
    );
  }

  return value;
}

function parseStringList(value: unknown, parameter: string): string[] {
  if (!Array.isArray(value)) {
    throw new LamedError("invalid_argument", `${parameter} must be an array.`, { parameter });
  }

  const parsed: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new LamedError("invalid_argument", `${parameter} must contain only strings.`, { parameter });
    }

    parsed.push(entry);
  }

  return parsed;
}

function parseEngineStore(store: unknown, operations: readonly EngineOperation[]): Store {
  if (store === null || typeof store !== "object" || Array.isArray(store)) {
    throw new LamedError("invalid_argument", "Engine store must be an object.", { parameter: "store" });
  }

  const candidate = store as Record<string, unknown>;

  for (const operation of operations) {
    if (typeof candidate[operation] !== "function") {
      throw new LamedError("invalid_argument", `Engine store does not implement "${operation}".`, {
        parameter: "store",
        operation,
      });
    }
  }

  return store as Store;
}

function mutableDescriptor(descriptor: EngineDescriptor): EngineDescriptor {
  const copy: EngineDescriptor = {
    kind: descriptor.kind,
    roles: [...descriptor.roles],
    operations: [...descriptor.operations],
    fieldTypes: [...descriptor.fieldTypes],
    exactness: descriptor.exactness,
    ordering: descriptor.ordering,
    snapshot: descriptor.snapshot,
    recovery: descriptor.recovery,
  };

  if (descriptor.region !== undefined) {
    copy.region = descriptor.region;
  }

  if (descriptor.resourceProfile !== undefined) {
    copy.resourceProfile = descriptor.resourceProfile;
  }

  return copy;
}

function isListed<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}

function listNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function fieldName(key: string | symbol): string {
  if (typeof key === "string") {
    return preview(key);
  }

  return preview(key.description ?? "symbol");
}
