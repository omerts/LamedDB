import { LamedError } from "../errors.js";
import { isPlainObject, LIMITS, parseCollectionName, preview } from "../validate.js";
import { EngineRegistry, parseEngineId } from "./registry.js";

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const POSITION = /^[\u0021-\u007E](?:[\u0020-\u007E]{0,254}[\u0021-\u007E])?$/;
const CHANGE_FIELDS = new Set(["defaultWriter", "ownership", "removePartitions", "representations"]);
const REPRESENTATION_FIELDS = new Set([
  "engine",
  "collection",
  "fields",
  "schemaVersion",
  "sourceGeneration",
  "appliedPosition",
  "manifestVersion",
]);

/** The one writer for a partition, and the epoch of that assignment. */
export interface OwnershipEntry {
  writer: string;
  epoch: number;
}

/**
 * A derived read of one collection.
 * `appliedPosition` stays unset until a change log exists.
 */
export interface ReadRepresentation {
  engine: string;
  collection: string;
  fields: readonly string[];
  /** Collection revision this representation was built from. */
  schemaVersion: number;
  /** Source recovery generation this representation was built from. */
  sourceGeneration: number;
  appliedPosition?: string;
  manifestVersion?: number;
}

/**
 * One published catalog snapshot.
 * `ownership` holds explicit partitions. A collection with no explicit entry uses the
 * default writer. `fallbackEpochs` records that collection's own epoch when it has
 * diverged from the default entry, so a resolved epoch never goes backwards.
 */
export interface CatalogGeneration {
  generation: number;
  defaultOwnership: OwnershipEntry;
  ownership: Readonly<Record<string, OwnershipEntry>>;
  fallbackEpochs?: Readonly<Record<string, number>>;
  representations: readonly ReadRepresentation[];
}

/**
 * A compare-and-swap update. Epochs are assigned by the catalog.
 * `ownership` maps a partition (a collection name) to its writer.
 * `removePartitions` drops explicit entries so those collections use the default writer.
 * `representations`, when present, replaces the representation list. An empty array clears it.
 */
export interface CatalogChange {
  defaultWriter?: string;
  ownership?: Readonly<Record<string, string>>;
  removePartitions?: readonly string[];
  representations?: readonly ReadRepresentation[];
}

interface InternalGeneration {
  generation: number;
  defaultOwnership: OwnershipEntry;
  ownership: Map<string, OwnershipEntry>;
  /**
   * Last effective writer and epoch for a partition that has been assigned or
   * has fallen back. Untouched partitions are absent and follow `defaultOwnership`.
   */
  remembered: Map<string, OwnershipEntry>;
  representations: readonly ReadRepresentation[];
}

interface ParsedChange {
  defaultWriter?: string;
  ownership: Map<string, string>;
  removePartitions: readonly string[];
  representations?: readonly ReadRepresentation[];
}

/**
 * In-memory routing catalog. Generations are immutable.
 * `publish` is compare-and-swap and does not yield between the check and the commit,
 * so two publishes that start from the same generation cannot both succeed.
 */
export class Catalog {
  private readonly registry: EngineRegistry;

  private head: InternalGeneration;

  constructor(registry: EngineRegistry, defaultWriterId: string) {
    if (!(registry instanceof EngineRegistry)) {
      throw new LamedError("invalid_argument", "Catalog requires an EngineRegistry.");
    }

    this.registry = registry;

    const writer = parseEngineId(defaultWriterId);

    assertWriteAuthority(this.registry, writer);

    this.head = {
      generation: 1,
      defaultOwnership: { writer, epoch: 1 },
      ownership: new Map(),
      remembered: new Map(),
      representations: [],
    };
  }

  /** A pinned copy of the latest generation. Later publishes do not change it. */
  current(): CatalogGeneration {
    return toPublicGeneration(this.head);
  }

  /** True when `candidate` is the registry this catalog validates writers against. */
  usesRegistry(candidate: EngineRegistry): boolean {
    return candidate === this.registry;
  }

  /**
   * Publish `change` only when `expectedGeneration` is still current.
   * A stale generation fails and leaves the catalog as it was.
   */
  publish(expectedGeneration: number, change: CatalogChange): CatalogGeneration {
    const expected = parsePositiveSafeInteger(expectedGeneration, "expectedGeneration");
    const parsed = parseChange(change);

    if (this.head.generation !== expected) {
      throw new LamedError(
        "precondition_failed",
        `Catalog generation ${expected} is stale. The current generation is ${this.head.generation}.`,
        { expectedGeneration: expected, generation: this.head.generation },
      );
    }

    assertApplicable(this.registry, this.head, parsed);

    const next = nextGeneration(this.head, parsed);

    this.head = next;

    return toPublicGeneration(next);
  }
}

/** The writer for `partition`: its explicit entry, or the default when it has none. */
export function resolveWriter(generation: CatalogGeneration, partition: string): OwnershipEntry {
  const name = parseCollectionName(partition);

  if (
    !isPlainObject(generation) ||
    !isPlainObject(generation.ownership) ||
    !isPlainObject(generation.defaultOwnership)
  ) {
    throw new LamedError("invalid_argument", "Catalog generation must be an object.");
  }

  const fallback = copyEntry(generation.defaultOwnership, name);

  if (Object.hasOwn(generation.ownership, name)) {
    return copyEntry(generation.ownership[name], name);
  }

  const fallbackEpochs = generation.fallbackEpochs;

  if (isPlainObject(fallbackEpochs) && Object.hasOwn(fallbackEpochs, name)) {
    const epoch = fallbackEpochs[name];

    if (typeof epoch !== "number") {
      throw new LamedError("invalid_argument", "Ownership entry must include a writer and an epoch.", {
        partition: name,
      });
    }

    return { writer: fallback.writer, epoch };
  }

  return fallback;
}

function copyEntry(entry: unknown, partition: string): OwnershipEntry {
  if (!isPlainObject(entry) || typeof entry.writer !== "string" || typeof entry.epoch !== "number") {
    throw new LamedError("invalid_argument", "Ownership entry must include a writer and an epoch.", {
      partition,
    });
  }

  return { writer: entry.writer, epoch: entry.epoch };
}

function assertApplicable(registry: EngineRegistry, head: InternalGeneration, change: ParsedChange): void {
  assertWriteAuthority(registry, change.defaultWriter ?? head.defaultOwnership.writer);

  for (const partition of change.removePartitions) {
    if (!head.ownership.has(partition)) {
      throw new LamedError("invalid_argument", `Partition "${partition}" has no explicit owner.`, {
        partition,
      });
    }
  }

  for (const writer of change.ownership.values()) {
    assertWriteAuthority(registry, writer);
  }

  const representations = change.representations ?? head.representations;

  for (const representation of representations) {
    assertDerivedRead(registry, representation.engine);
  }
}

function nextGeneration(head: InternalGeneration, change: ParsedChange): InternalGeneration {
  const ownership = new Map(head.ownership);
  const remembered = new Map(head.remembered);
  let defaultOwnership = { ...head.defaultOwnership };

  if (change.defaultWriter !== undefined && change.defaultWriter !== defaultOwnership.writer) {
    defaultOwnership = {
      writer: change.defaultWriter,
      epoch: nextCount(defaultOwnership.epoch, "Ownership epoch"),
    };

    for (const [partition, state] of remembered) {
      if (ownership.has(partition) || state.writer === defaultOwnership.writer) {
        continue;
      }

      remembered.set(partition, advance(state, defaultOwnership.writer));
    }
  }

  for (const partition of change.removePartitions) {
    const current = ownership.get(partition);

    if (!current) {
      throw new LamedError("invalid_argument", `Partition "${partition}" has no explicit owner.`, {
        partition,
      });
    }

    ownership.delete(partition);
    remembered.set(
      partition,
      current.writer === defaultOwnership.writer
        ? { writer: current.writer, epoch: current.epoch }
        : advance(current, defaultOwnership.writer),
    );
  }

  for (const [partition, writer] of change.ownership) {
    const current = ownership.get(partition) ?? remembered.get(partition) ?? defaultOwnership;
    const entry = current.writer === writer ? { writer, epoch: current.epoch } : advance(current, writer);

    remembered.set(partition, entry);
    ownership.set(partition, entry);
  }

  return {
    generation: nextCount(head.generation, "Catalog generation"),
    defaultOwnership,
    ownership,
    remembered,
    representations: change.representations ?? head.representations.map(copyRepresentation),
  };
}

/** The next epoch for a partition whose writer is changing. The same writer keeps its epoch. */
function advance(current: OwnershipEntry, writer: string): OwnershipEntry {
  return {
    writer,
    epoch: nextCount(current.epoch, "Ownership epoch"),
  };
}

function assertWriteAuthority(registry: EngineRegistry, id: string): void {
  const engine = registry.get(id);

  if (!engine) {
    throw new LamedError("invalid_argument", `Engine "${id}" is not registered.`, { id });
  }

  if (!engine.descriptor.roles.includes("write-authority")) {
    throw new LamedError("invalid_argument", `Engine "${id}" is not a write authority.`, { id });
  }
}

function assertDerivedRead(registry: EngineRegistry, id: string): void {
  const engine = registry.get(id);

  if (!engine) {
    throw new LamedError("invalid_argument", `Engine "${id}" is not registered.`, { id });
  }

  if (!engine.descriptor.roles.includes("derived-read")) {
    throw new LamedError("invalid_argument", `Engine "${id}" is not a derived read.`, { id });
  }
}

function parseChange(change: unknown): ParsedChange {
  if (!isPlainObject(change)) {
    throw new LamedError("invalid_argument", "Catalog change must be an object.");
  }

  for (const key of Reflect.ownKeys(change)) {
    if (typeof key !== "string" || !CHANGE_FIELDS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown catalog change field "${keyName(key)}".`);
    }
  }

  const defaultWriter = change.defaultWriter === undefined ? undefined : parseEngineId(change.defaultWriter);
  const ownership = parseOwnership(change.ownership);
  const removePartitions = parseRemovePartitions(change.removePartitions);
  const representations =
    change.representations === undefined ? undefined : parseRepresentations(change.representations);

  for (const partition of removePartitions) {
    if (ownership.has(partition)) {
      throw new LamedError(
        "invalid_argument",
        `Partition "${partition}" cannot be removed and assigned in one change.`,
        { partition },
      );
    }
  }

  if (
    defaultWriter === undefined &&
    ownership.size === 0 &&
    removePartitions.length === 0 &&
    representations === undefined
  ) {
    throw new LamedError("invalid_argument", "Catalog change must update ownership or representations.");
  }

  return {
    ...(defaultWriter !== undefined ? { defaultWriter } : {}),
    ownership,
    removePartitions,
    ...(representations !== undefined ? { representations } : {}),
  };
}

function parseOwnership(ownership: unknown): Map<string, string> {
  if (ownership === undefined) {
    return new Map();
  }

  if (!isPlainObject(ownership)) {
    throw new LamedError("invalid_argument", "ownership must be an object.", { parameter: "ownership" });
  }

  const names = Object.keys(ownership);

  if (names.length > LIMITS.maxObjectKeys) {
    throw new LamedError(
      "invalid_argument",
      `ownership has ${names.length} partitions. The limit is ${LIMITS.maxObjectKeys}.`,
      { parameter: "ownership" },
    );
  }

  const parsed = new Map<string, string>();

  for (const name of names) {
    const partition = parseCollectionName(name);

    parsed.set(partition, parseEngineId(ownership[name]));
  }

  return parsed;
}

function parseRemovePartitions(removePartitions: unknown): string[] {
  if (removePartitions === undefined) {
    return [];
  }

  if (!Array.isArray(removePartitions)) {
    throw new LamedError("invalid_argument", "removePartitions must be an array.", {
      parameter: "removePartitions",
    });
  }

  if (removePartitions.length > LIMITS.maxArrayItems) {
    throw new LamedError(
      "invalid_argument",
      `removePartitions has ${removePartitions.length} entries. The limit is ${LIMITS.maxArrayItems}.`,
      { parameter: "removePartitions" },
    );
  }

  const parsed: string[] = [];

  for (const entry of removePartitions) {
    const partition = parseCollectionName(entry);

    if (parsed.includes(partition)) {
      throw new LamedError("invalid_argument", `Partition "${partition}" is listed more than once.`, {
        partition,
      });
    }

    parsed.push(partition);
  }

  return parsed;
}

function parseRepresentations(representations: unknown): ReadRepresentation[] {
  if (!Array.isArray(representations)) {
    throw new LamedError("invalid_argument", "representations must be an array.", {
      parameter: "representations",
    });
  }

  if (representations.length > LIMITS.maxArrayItems) {
    throw new LamedError(
      "invalid_argument",
      `representations has ${representations.length} entries. The limit is ${LIMITS.maxArrayItems}.`,
      { parameter: "representations" },
    );
  }

  const parsed: ReadRepresentation[] = [];
  const seen = new Set<string>();

  for (const entry of representations) {
    const representation = parseRepresentation(entry);
    const identity = representationIdentity(representation);

    if (seen.has(identity)) {
      throw new LamedError(
        "invalid_argument",
        `Duplicate read representation for "${representation.collection}" on engine "${representation.engine}".`,
        { collection: representation.collection, engine: representation.engine },
      );
    }

    seen.add(identity);
    parsed.push(representation);
  }

  return parsed;
}

function parseRepresentation(entry: unknown): ReadRepresentation {
  if (!isPlainObject(entry)) {
    throw new LamedError("invalid_argument", "Read representation must be an object.");
  }

  for (const key of Reflect.ownKeys(entry)) {
    if (typeof key !== "string" || !REPRESENTATION_FIELDS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown representation field "${keyName(key)}".`);
    }
  }

  const representation: ReadRepresentation = {
    engine: parseEngineId(entry.engine),
    collection: parseCollectionName(entry.collection),
    fields: parseFields(entry.fields),
    schemaVersion: parsePositiveSafeInteger(entry.schemaVersion, "schemaVersion"),
    sourceGeneration: parsePositiveSafeInteger(entry.sourceGeneration, "sourceGeneration"),
  };

  if (entry.appliedPosition !== undefined) {
    representation.appliedPosition = parsePosition(entry.appliedPosition);
  }

  if (entry.manifestVersion !== undefined) {
    representation.manifestVersion = parsePositiveSafeInteger(entry.manifestVersion, "manifestVersion");
  }

  return Object.freeze(representation);
}

function parseFields(fields: unknown): readonly string[] {
  if (!Array.isArray(fields)) {
    throw new LamedError("invalid_argument", "fields must be an array.", { parameter: "fields" });
  }

  if (fields.length < 1 || fields.length > LIMITS.maxDeclaredFields) {
    throw new LamedError(
      "invalid_argument",
      `A read representation must name 1-${LIMITS.maxDeclaredFields} fields.`,
      { parameter: "fields" },
    );
  }

  const parsed: string[] = [];

  for (const field of fields) {
    if (typeof field !== "string" || !FIELD_NAME.test(field)) {
      const rendered = typeof field === "string" ? `"${preview(field)}"` : "value";

      throw new LamedError(
        "invalid_argument",
        `Field name ${rendered} is not allowed. Use a letter or underscore, then letters, digits, or underscores, up to 64 characters.`,
        { parameter: "fields" },
      );
    }

    if (parsed.includes(field)) {
      throw new LamedError("invalid_argument", `Field "${field}" is listed more than once.`, {
        parameter: "fields",
      });
    }

    parsed.push(field);
  }

  return Object.freeze(parsed);
}

function parsePosition(position: unknown): string {
  if (typeof position !== "string" || position.length < 1 || position.length > 256 || !POSITION.test(position)) {
    throw new LamedError(
      "invalid_argument",
      "appliedPosition must be 1-256 printable ASCII characters with no leading or trailing whitespace.",
      { parameter: "appliedPosition" },
    );
  }

  return position;
}

function representationIdentity(representation: ReadRepresentation): string {
  const fields = [...representation.fields].sort().join(",");

  return `${representation.engine}\0${representation.collection}\0${representation.schemaVersion}\0${fields}`;
}

function toPublicGeneration(head: InternalGeneration): CatalogGeneration {
  const ownership: Record<string, OwnershipEntry> = Object.create(null);
  const fallbackEpochs: Record<string, number> = Object.create(null);

  for (const [partition, entry] of head.ownership) {
    Object.defineProperty(ownership, partition, {
      value: Object.freeze({ writer: entry.writer, epoch: entry.epoch }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  for (const [partition, state] of head.remembered) {
    if (head.ownership.has(partition)) {
      continue;
    }

    if (state.writer === head.defaultOwnership.writer && state.epoch === head.defaultOwnership.epoch) {
      continue;
    }

    Object.defineProperty(fallbackEpochs, partition, {
      value: state.epoch,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  const generation: CatalogGeneration = {
    generation: head.generation,
    defaultOwnership: Object.freeze({ ...head.defaultOwnership }),
    ownership: Object.freeze(ownership),
    representations: Object.freeze(head.representations.map(copyRepresentation)),
  };

  if (Object.keys(fallbackEpochs).length > 0) {
    generation.fallbackEpochs = Object.freeze(fallbackEpochs);
  }

  return Object.freeze(generation);
}

function copyRepresentation(representation: ReadRepresentation): ReadRepresentation {
  const copy: ReadRepresentation = {
    engine: representation.engine,
    collection: representation.collection,
    fields: Object.freeze([...representation.fields]),
    schemaVersion: representation.schemaVersion,
    sourceGeneration: representation.sourceGeneration,
  };

  if (representation.appliedPosition !== undefined) {
    copy.appliedPosition = representation.appliedPosition;
  }

  if (representation.manifestVersion !== undefined) {
    copy.manifestVersion = representation.manifestVersion;
  }

  return Object.freeze(copy);
}

function parsePositiveSafeInteger(value: unknown, parameter: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new LamedError("invalid_argument", `${parameter} must be a positive safe integer.`, {
      parameter,
    });
  }

  return value;
}

function nextCount(current: number, label: string): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new LamedError("invalid_argument", `${label} cannot increase past the safe integer range.`);
  }

  return current + 1;
}

function keyName(key: string | symbol): string {
  if (typeof key === "string") {
    return preview(key);
  }

  return preview(key.description ?? "symbol");
}
