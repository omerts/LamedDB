export { CollectionService } from "./collections/service.js";
export type { CollectionServiceOptions, PutOutcome } from "./collections/service.js";
export {
  ENGINE_EXACTNESS,
  ENGINE_OPERATIONS,
  ENGINE_RECOVERY,
  ENGINE_ROLES,
  ENGINE_SNAPSHOTS,
  EngineRegistry,
  memoryStoreDescriptor,
  postgresStoreDescriptor,
} from "./engine/registry.js";
export type {
  EngineStore,
  EngineDescriptor,
  EngineExactness,
  EngineOperation,
  EngineRecovery,
  EngineRole,
  EngineSnapshot,
  RegisteredEngine,
} from "./engine/registry.js";
export { Catalog, resolveWriter } from "./engine/catalog.js";
export { Router, SINGLE_STORE_ENGINE_ID, routerForStore } from "./engine/router.js";
export type { LogicalRequest, RequestConsistency, RequestScope, ResolvedRoute } from "./engine/router.js";
export type {
  CatalogChange,
  CatalogGeneration,
  OwnershipEntry,
  ReadRepresentation,
} from "./engine/catalog.js";
export { LamedError } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export { listen } from "./http/server.js";
export type { ListenOptions, RunningServer } from "./http/server.js";
export { CollectionClient, LamedDB } from "./sdk/client.js";
export type { LamedDBOptions } from "./sdk/client.js";
export { MemoryStore } from "./storage/memory-store.js";
export type { MemoryStoreOptions } from "./storage/memory-store.js";
export { PostgresStore } from "./storage/postgres-store.js";
export type { PostgresStoreOptions, StoredChange } from "./storage/postgres-store.js";
export type { Store } from "./storage/store.js";
export type {
  CollectionInfo,
  CollectionSpec,
  FieldMap,
  FieldType,
  FilterOperator,
  FilterOperators,
  FilterScalar,
  JsonObject,
  JsonValue,
  ListOptions,
  ListResult,
  AliasMap,
  PutOptions,
  RecordEnvelope,
} from "./types.js";
