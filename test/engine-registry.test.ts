import { describe, expect, it } from "vitest";

import {
  ENGINE_OPERATIONS,
  EngineRegistry,
  LamedError,
  MemoryStore,
  memoryStoreDescriptor,
  type EngineDescriptor,
  type EngineOperation,
  type EngineRole,
  type FieldType,
  type Store,
} from "../src/index.js";

function registryWithMemory(): { registry: EngineRegistry; store: MemoryStore } {
  const registry = new EngineRegistry();
  const store = new MemoryStore();

  registry.register("memory", store, memoryStoreDescriptor());

  return { registry, store };
}

function expectRejected(run: () => void, message: RegExp): LamedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LamedError);

    const rejected = error as LamedError;

    expect(rejected.code).toBe("invalid_argument");
    expect(rejected.message).toMatch(message);

    return rejected;
  }

  throw new Error("expected registration to throw");
}

describe("engine registry", () => {
  it("registers MemoryStore with an honest descriptor", () => {
    const { registry, store } = registryWithMemory();
    const registered = registry.get("memory");

    expect(registered?.store).toBe(store);
    expect(registered?.descriptor).toEqual({
      kind: "memory",
      roles: ["write-authority"],
      operations: [...ENGINE_OPERATIONS],
      fieldTypes: ["string", "integer", "timestamp"],
      exactness: "exact",
      ordering: true,
      snapshot: "per-call",
      recovery: "none",
    });
    expect(registered?.descriptor).not.toHaveProperty("region");
    expect(registered?.descriptor).not.toHaveProperty("resourceProfile");
  });

  it("rejects a duplicate id and keeps the original engine", () => {
    const { registry, store } = registryWithMemory();
    const other = new MemoryStore();

    expectRejected(
      () => registry.register("memory", other, memoryStoreDescriptor()),
      /already registered/,
    );

    expect(registry.get("memory")?.store).toBe(store);
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects an empty id and registers nothing", () => {
    const registry = new EngineRegistry();

    expectRejected(() => registry.register("", new MemoryStore(), memoryStoreDescriptor()), /must not be empty/);
    expectRejected(() => registry.register("   ", new MemoryStore(), memoryStoreDescriptor()), /must not be empty/);
    expectRejected(
      () => registry.register(1 as unknown as string, new MemoryStore(), memoryStoreDescriptor()),
      /must be a string/,
    );
    expect(registry.get("")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("rejects an unknown operation and registers nothing", () => {
    const registry = new EngineRegistry();
    const descriptor = memoryStoreDescriptor();

    descriptor.operations = ["dropTable" as EngineDescriptor["operations"][number]];

    expectRejected(
      () => registry.register("memory", new MemoryStore(), descriptor),
      /Unknown operation "dropTable"/,
    );
    expect(registry.get("memory")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("rejects an unknown field type and registers nothing", () => {
    const registry = new EngineRegistry();
    const descriptor = memoryStoreDescriptor();

    descriptor.fieldTypes = ["boolean" as EngineDescriptor["fieldTypes"][number]];

    expectRejected(
      () => registry.register("memory", new MemoryStore(), descriptor),
      /Unknown field type "boolean"/,
    );
    expect(registry.list()).toEqual([]);
  });

  it("rejects a descriptor with no role and registers nothing", () => {
    const registry = new EngineRegistry();
    const descriptor = memoryStoreDescriptor();

    descriptor.roles = [];

    expectRejected(() => registry.register("memory", new MemoryStore(), descriptor), /at least one role/);
    expect(registry.get("memory")).toBeUndefined();
  });

  it("returns undefined for an unknown id and never a default engine", () => {
    const empty = new EngineRegistry();
    const { registry } = registryWithMemory();

    expect(empty.get("memory")).toBeUndefined();
    expect(empty.list()).toEqual([]);
    expect(registry.get("other")).toBeUndefined();
    expect(registry.list().map((engine) => engine.id)).toEqual(["memory"]);
  });

  it("keeps two MemoryStore instances independent", async () => {
    const registry = new EngineRegistry();
    const left = new MemoryStore();
    const right = new MemoryStore();

    registry.register("left", left, memoryStoreDescriptor());
    registry.register("right", right, memoryStoreDescriptor());

    const leftStore = registry.get("left")?.store;
    const rightStore = registry.get("right")?.store;

    expect(leftStore).toBe(left);
    expect(rightStore).toBe(right);

    await leftStore?.createCollection("orders", { status: "string" });

    await expect(rightStore?.getCollection("orders")).resolves.toBeNull();
    await expect(leftStore?.getCollection("orders")).resolves.toMatchObject({ name: "orders" });
    expect(registry.list().map((engine) => engine.id)).toEqual(["left", "right"]);
  });

  it("does not let a caller mutate the registered descriptor", () => {
    const registry = new EngineRegistry();
    const provided = memoryStoreDescriptor();

    registry.register("memory", new MemoryStore(), provided);
    provided.kind = "postgres";
    (provided.roles as EngineRole[]).push("derived-read");
    (provided.operations as EngineOperation[]).push("putRecord");
    (provided.fieldTypes as FieldType[]).push("string");
    provided.recovery = "durable";

    const returned = registry.get("memory")?.descriptor;

    expect(returned).toEqual(memoryStoreDescriptor());

    if (returned) {
      (returned.roles as EngineRole[]).push("derived-read");
      (returned.operations as EngineOperation[]).pop();
      (returned.fieldTypes as FieldType[]).pop();
      returned.kind = "postgres";
      returned.ordering = false;
      returned.recovery = "durable";
    }

    const listed = registry.list();

    listed.pop();

    if (listed[0]) {
      listed[0].descriptor.snapshot = "per-call";
      listed[0].descriptor.exactness = "approximate";
      (listed[0].descriptor.roles as EngineRole[]).push("derived-read");
    }

    expect(registry.get("memory")?.descriptor).toEqual(memoryStoreDescriptor());
    expect(registry.list()).toHaveLength(1);
    expect(memoryStoreDescriptor().operations).toEqual([...ENGINE_OPERATIONS]);
  });

  it("rejects a bad descriptor or store without dropping engines already registered", () => {
    const { registry, store } = registryWithMemory();
    const descriptor = memoryStoreDescriptor();

    descriptor.roles = ["primary" as EngineDescriptor["roles"][number]];
    expectRejected(() => registry.register("other", new MemoryStore(), descriptor), /Unknown role/);

    const extra = memoryStoreDescriptor();

    Object.defineProperty(extra, "durability", { value: "disk", enumerable: false });
    expectRejected(() => registry.register("other", new MemoryStore(), extra), /Unknown descriptor field/);

    const symbolic = memoryStoreDescriptor();

    Object.defineProperty(symbolic, Symbol("extra"), { value: true });
    expectRejected(() => registry.register("other", new MemoryStore(), symbolic), /Unknown descriptor field/);

    const missing = memoryStoreDescriptor();

    missing.operations = ["listRecords"];
    expectRejected(
      () => registry.register("other", { listRecords: true } as unknown as Store, missing),
      /does not implement "listRecords"/,
    );

    expect(registry.get("other")).toBeUndefined();
    expect(registry.get("memory")?.store).toBe(store);
    expect(registry.list()).toHaveLength(1);
  });

  it("accepts an engine that is both a write authority and a derived read", () => {
    const registry = new EngineRegistry();
    const descriptor = memoryStoreDescriptor();

    descriptor.roles = ["write-authority", "derived-read"];
    registry.register("mixed", new MemoryStore(), descriptor);

    expect(registry.get("mixed")?.descriptor.roles).toEqual(["write-authority", "derived-read"]);
  });

  it("registers a non-memory engine from its own descriptor", () => {
    const registry = new EngineRegistry();
    const descriptor = memoryStoreDescriptor();

    descriptor.kind = "postgres";
    descriptor.recovery = "durable";
    descriptor.region = "us-east-1";
    descriptor.resourceProfile = "small";
    registry.register("pg", new MemoryStore(), descriptor);

    expect(registry.get("pg")?.descriptor).toEqual({
      ...memoryStoreDescriptor(),
      kind: "postgres",
      recovery: "durable",
      region: "us-east-1",
      resourceProfile: "small",
    });
  });

  it("rejects descriptor claims this version does not understand", () => {
    const registry = new EngineRegistry();
    const cases: Array<{ descriptor: EngineDescriptor; message: RegExp }> = [
      { descriptor: { ...memoryStoreDescriptor(), exactness: "precise" as "exact" }, message: /exactness/ },
      { descriptor: { ...memoryStoreDescriptor(), recovery: "disk" as "none" }, message: /recovery/ },
      { descriptor: { ...memoryStoreDescriptor(), snapshot: "pinned" as "per-call" }, message: /snapshot/ },
      { descriptor: { ...memoryStoreDescriptor(), ordering: "yes" as unknown as boolean }, message: /ordering/ },
      { descriptor: { ...memoryStoreDescriptor(), kind: "" }, message: /kind/ },
      { descriptor: { ...memoryStoreDescriptor(), region: " " }, message: /region/ },
      {
        descriptor: {
          ...memoryStoreDescriptor(),
          roles: ["write-authority", "write-authority"],
        },
        message: /more than once/,
      },
    ];

    for (const entry of cases) {
      expectRejected(() => registry.register("memory", new MemoryStore(), entry.descriptor), entry.message);
    }

    expectRejected(
      () => registry.register("memory", new MemoryStore(), null as unknown as EngineDescriptor),
      /descriptor must be an object/,
    );
    expectRejected(
      () => registry.register("memory", null as unknown as Store, memoryStoreDescriptor()),
      /store must be an object/,
    );
    expectRejected(
      () =>
        registry.register("memory", new MemoryStore(), {
          ...memoryStoreDescriptor(),
          operations: "putRecord",
        } as unknown as EngineDescriptor),
      /operations must be an array/,
    );
    expect(() => registry.get(1 as unknown as string)).toThrow(LamedError);
    expect(registry.list()).toEqual([]);
  });
});
