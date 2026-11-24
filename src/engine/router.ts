import { LamedError } from "../errors.js";
import type { Store } from "../storage/store.js";
import { isPlainObject, parseCollectionName, preview } from "../validate.js";
import { Catalog, resolveWriter } from "./catalog.js";
import {
  ENGINE_OPERATIONS,
  EngineRegistry,
  memoryStoreDescriptor,
  type EngineOperation,
  type EngineStore,
} from "./registry.js";

/** Id of the engine created when one store is wrapped for the current server. */
export const SINGLE_STORE_ENGINE_ID = "memory";

export const REQUEST_SCOPES = Object.freeze(["default"] as const);

export type RequestScope = (typeof REQUEST_SCOPES)[number];

export const REQUEST_CONSISTENCY = Object.freeze(["strong"] as const);

export type RequestConsistency = (typeof REQUEST_CONSISTENCY)[number];

/**
 * One storage use case. Engine selection stays inside the router.
 * `scope` is `default` until requests are tenant-scoped.
 * `consistency` is `strong` until a bounded-staleness option exists.
 * `deadline` is carried and checked for shape. It is not enforced.
 */
export interface LogicalRequest {
  operation: EngineOperation;
  collection: string;
  scope: RequestScope;
  consistency: RequestConsistency;
  deadline?: number;
}

/** The engine chosen for one pinned catalog generation. */
export interface ResolvedRoute {
  engineId: string;
  store: EngineStore;
  generation: number;
  epoch: number;
  /** Operations this engine lists. Callers must not invoke any other method. */
  operations: readonly EngineOperation[];
}

const REQUEST_FIELDS = new Set(["operation", "collection", "scope", "consistency", "deadline"]);

/**
 * Resolves a logical request to one engine.
 * The writer and its epoch come from `resolveWriter` on the generation pinned
 * by this call. Reads use that same writer: a derived representation is eligible
 * only when it matches the collection, schema version, and fields, and choosing
 * one would split the use case across engines. None is selected in this step.
 */
export class Router {
  private readonly registry: EngineRegistry;

  private readonly catalog: Catalog;

  constructor(registry: EngineRegistry, catalog: Catalog) {
    if (!(registry instanceof EngineRegistry)) {
      throw new LamedError("invalid_argument", "Router requires an EngineRegistry.");
    }

    if (!(catalog instanceof Catalog)) {
      throw new LamedError("invalid_argument", "Router requires a Catalog.");
    }

    if (!catalog.usesRegistry(registry)) {
      throw new LamedError("invalid_argument", "Router catalog must use the same registry.");
    }

    this.registry = registry;
    this.catalog = catalog;
  }

  /**
   * Pin the current catalog generation and choose its writer for `request`.
   * A later publish does not change this result. No other engine is substituted.
   */
  resolve(request: LogicalRequest): ResolvedRoute {
    const parsed = parseLogicalRequest(request);
    const pinned = this.catalog.current();
    const owner = resolveWriter(pinned, parsed.collection);
    const registered = this.registry.get(owner.writer);

    if (registered === undefined || !registered.descriptor.operations.includes(parsed.operation)) {
      throw new LamedError("internal", `No qualified route for operation "${parsed.operation}".`, {
        operation: parsed.operation,
      });
    }

    return {
      engineId: registered.id,
      store: registered.store,
      generation: pinned.generation,
      epoch: owner.epoch,
      operations: Object.freeze([...registered.descriptor.operations]),
    };
  }
}

/**
 * One registry, catalog, and router around a single store.
 * `listen({ store })` and `new CollectionService(store)` use this so existing
 * callers keep one engine without building the catalog themselves.
 */
export function routerForStore(store: Store): Router {
  const registry = new EngineRegistry();

  registry.register(SINGLE_STORE_ENGINE_ID, store, memoryStoreDescriptor());

  return new Router(registry, new Catalog(registry, SINGLE_STORE_ENGINE_ID));
}

function parseLogicalRequest(request: unknown): LogicalRequest {
  if (!isPlainObject(request)) {
    throw new LamedError("invalid_argument", "Logical request must be an object.");
  }

  for (const key of Reflect.ownKeys(request)) {
    if (typeof key !== "string" || !REQUEST_FIELDS.has(key)) {
      throw new LamedError("invalid_argument", `Unknown logical request field "${fieldName(key)}".`);
    }
  }

  const parsed: LogicalRequest = {
    operation: parseOperation(request.operation),
    collection: parseCollectionName(request.collection),
    scope: parseScope(request.scope),
    consistency: parseConsistency(request.consistency),
  };

  // Accepted so the request can name a deadline. Enforcement is a later step.
  if (request.deadline !== undefined) {
    parsed.deadline = parseDeadline(request.deadline);
  }

  return parsed;
}

function parseOperation(operation: unknown): EngineOperation {
  if (typeof operation !== "string" || !isListed(operation, ENGINE_OPERATIONS)) {
    throw new LamedError(
      "invalid_argument",
      `operation must be one of ${listNames(ENGINE_OPERATIONS)}.`,
      { parameter: "operation" },
    );
  }

  return operation;
}

function parseScope(scope: unknown): RequestScope {
  if (scope !== "default") {
    throw new LamedError("invalid_argument", 'scope must be "default".', { parameter: "scope" });
  }

  return scope;
}

function parseConsistency(consistency: unknown): RequestConsistency {
  if (consistency !== "strong") {
    throw new LamedError("invalid_argument", 'consistency must be "strong".', {
      parameter: "consistency",
    });
  }

  return consistency;
}

function parseDeadline(deadline: unknown): number {
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < 0) {
    throw new LamedError("invalid_argument", "deadline must be a non-negative safe integer.", {
      parameter: "deadline",
    });
  }

  return deadline;
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
