import { describe, expect, it } from "vitest";

import {
  Catalog,
  EngineRegistry,
  LamedError,
  MemoryStore,
  memoryStoreDescriptor,
  resolveWriter,
  type ReadRepresentation,
} from "../src/index.js";

function registerEngines(): EngineRegistry {
  const registry = new EngineRegistry();

  registry.register("memory", new MemoryStore(), memoryStoreDescriptor());
  registry.register("other", new MemoryStore(), memoryStoreDescriptor());

  const column = memoryStoreDescriptor();

  column.kind = "column";
  column.roles = ["derived-read"];
  column.operations = ["listRecords"];
  column.exactness = "approximate";
  column.ordering = false;
  registry.register("column", { listRecords: async () => ({ records: [], hasMore: false }) }, column);

  return registry;
}

function openCatalog(): { registry: EngineRegistry; catalog: Catalog } {
  const registry = registerEngines();

  return { registry, catalog: new Catalog(registry, "memory") };
}

function representation(overrides: Partial<ReadRepresentation> = {}): ReadRepresentation {
  return {
    engine: "column",
    collection: "orders",
    fields: ["status"],
    schemaVersion: 1,
    sourceGeneration: 1,
    ...overrides,
  };
}

function expectInvalid(run: () => void, message: RegExp): LamedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LamedError);

    const rejected = error as LamedError;

    expect(rejected.code).toBe("invalid_argument");
    expect(rejected.message).toMatch(message);

    return rejected;
  }

  throw new Error("expected the catalog call to throw");
}

describe("routing catalog", () => {
  it("starts at generation 1 with the default engine owning every collection", () => {
    const { catalog } = openCatalog();
    const current = catalog.current();

    expect(current).toEqual({
      generation: 1,
      defaultOwnership: { writer: "memory", epoch: 1 },
      ownership: {},
      representations: [],
    });
    expect(resolveWriter(current, "orders")).toEqual({ writer: "memory", epoch: 1 });
    expect(resolveWriter(current, "tickets")).toEqual({ writer: "memory", epoch: 1 });
    expect(resolveWriter(current, "constructor")).toEqual({ writer: "memory", epoch: 1 });
    expect(resolveWriter(current, "toString")).toEqual({ writer: "memory", epoch: 1 });
  });

  it("rejects a stale publish and leaves the catalog and the previous snapshot unchanged", () => {
    const { catalog } = openCatalog();
    const pinned = catalog.current();

    catalog.publish(1, { defaultWriter: "other" });

    const after = catalog.current();

    expect(() => catalog.publish(1, { ownership: { orders: "memory" } })).toThrow(LamedError);

    try {
      catalog.publish(1, { ownership: { orders: "other" } });
    } catch (error) {
      expect(error).toBeInstanceOf(LamedError);
      expect((error as LamedError).code).toBe("precondition_failed");
    }

    expect(catalog.current()).toEqual(after);
    expect(catalog.current().ownership).toEqual({});
    expect(pinned).toEqual({
      generation: 1,
      defaultOwnership: { writer: "memory", epoch: 1 },
      ownership: {},
      representations: [],
    });
    expect(after.defaultOwnership).toEqual({ writer: "other", epoch: 2 });
  });

  it("lets exactly one of two publishes from the same generation succeed", async () => {
    const { catalog } = openCatalog();
    const generation = catalog.current().generation;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => catalog.publish(generation, { ownership: { orders: "memory" } })),
      Promise.resolve().then(() => catalog.publish(generation, { ownership: { tickets: "other" } })),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0];

    if (failure?.status === "rejected") {
      expect(failure.reason).toBeInstanceOf(LamedError);
      expect((failure.reason as LamedError).code).toBe("precondition_failed");
    }

    const current = catalog.current();
    const partitions = Object.keys(current.ownership);
    const partition = partitions[0];

    expect(current.generation).toBe(generation + 1);
    expect(partitions).toHaveLength(1);
    expect(partition === "orders" || partition === "tickets").toBe(true);
    expect(current.ownership[partition ?? ""]?.writer).toBe(partition === "orders" ? "memory" : "other");
  });

  it("gives each partition one writer and rejects an engine that cannot write", () => {
    const { catalog } = openCatalog();
    const before = catalog.current();

    expectInvalid(() => catalog.publish(1, { ownership: { orders: "missing" } }), /not registered/);
    expectInvalid(() => catalog.publish(1, { ownership: { orders: "column" } }), /not a write authority/);
    expect(catalog.current()).toEqual(before);

    const first = catalog.publish(1, { ownership: { orders: "memory", tickets: "other" } });

    expect(first.ownership.orders).toEqual({ writer: "memory", epoch: 1 });
    expect(first.ownership.tickets).toEqual({ writer: "other", epoch: 2 });
    expect(resolveWriter(first, "orders").writer).toBe("memory");
    expect(resolveWriter(first, "payments")).toEqual(first.defaultOwnership);

    const replaced = catalog.publish(2, { ownership: { orders: "other" } });

    expect(replaced.ownership.orders).toEqual({ writer: "other", epoch: 2 });
    expect(replaced.ownership.tickets).toEqual({ writer: "other", epoch: 2 });
    expect(Object.keys(replaced.ownership)).toEqual(["orders", "tickets"]);
  });

  it("increases epochs when the writer changes and does not reuse one after removal", () => {
    const { catalog } = openCatalog();

    expect(catalog.publish(1, { defaultWriter: "memory" }).defaultOwnership).toEqual({
      writer: "memory",
      epoch: 1,
    });

    const assigned = catalog.publish(2, { ownership: { orders: "memory" } });

    expect(assigned.ownership.orders).toEqual({ writer: "memory", epoch: 1 });

    const same = catalog.publish(3, { ownership: { orders: "memory" } });

    expect(same.ownership.orders).toEqual({ writer: "memory", epoch: 1 });
    expect(same.generation).toBe(4);

    const moved = catalog.publish(4, { ownership: { orders: "other" } });

    expect(moved.ownership.orders).toEqual({ writer: "other", epoch: 2 });

    const removed = catalog.publish(5, { removePartitions: ["orders"] });

    expect(Object.keys(removed.ownership)).toEqual([]);
    expect(resolveWriter(removed, "orders")).toEqual({ writer: "memory", epoch: 3 });
    expect(removed.fallbackEpochs).toEqual({ orders: 3 });

    const restored = catalog.publish(6, { ownership: { orders: "memory" } });

    expect(restored.ownership.orders).toEqual({ writer: "memory", epoch: 3 });
    expect(restored.fallbackEpochs).toBeUndefined();

    const switched = catalog.publish(7, { defaultWriter: "other" });

    expect(switched.defaultOwnership).toEqual({ writer: "other", epoch: 2 });
    expect(switched.ownership.orders).toEqual({ writer: "memory", epoch: 3 });

    const switchedBack = catalog.publish(8, { defaultWriter: "memory" });

    expect(switchedBack.defaultOwnership).toEqual({ writer: "memory", epoch: 3 });
    expect(switchedBack.ownership.orders?.epoch).toBe(3);
  });

  it("keeps a returned generation pinned after later publishes", () => {
    const { catalog } = openCatalog();
    const pinned = catalog.current();

    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(pinned.ownership)).toBe(true);
    expect(Object.isFrozen(pinned.representations)).toBe(true);

    catalog.publish(1, {
      ownership: { orders: "other" },
      representations: [representation()],
    });

    expect(pinned.generation).toBe(1);
    expect(pinned.defaultOwnership).toEqual({ writer: "memory", epoch: 1 });
    expect(pinned.ownership).toEqual({});
    expect(pinned.representations).toEqual([]);

    const published = catalog.current();

    expect(published.generation).toBe(2);
    expect(published.ownership.orders).toEqual({ writer: "other", epoch: 2 });
    expect(published.representations).toEqual([representation()]);
    expect(published).not.toBe(pinned);
  });

  it("stores read representations only for a derived read, and an empty list clears them", () => {
    const { catalog } = openCatalog();
    const before = catalog.current();

    expectInvalid(
      () => catalog.publish(1, { representations: [representation({ engine: "memory" })] }),
      /not a derived read/,
    );
    expectInvalid(
      () =>
        catalog.publish(1, {
          representations: [representation(), representation({ collection: "tickets", engine: "missing" })],
        }),
      /not registered/,
    );
    expect(catalog.current()).toEqual(before);

    const input = representation();
    const published = catalog.publish(1, {
      representations: [
        input,
        representation({ collection: "tickets", fields: ["status", "totalCents"] }),
      ],
    });

    input.engine = "memory";
    (input.fields as string[]).push("note");
    const orders = published.representations[0];
    const tickets = published.representations[1];

    expect(orders).toEqual(representation());
    expect(orders).not.toHaveProperty("appliedPosition");
    expect(orders).not.toHaveProperty("manifestVersion");
    expect(tickets?.fields).toEqual(["status", "totalCents"]);

    const located = catalog.publish(2, {
      representations: [representation({ appliedPosition: "42", manifestVersion: 3 })],
    });

    expect(located.representations).toEqual([
      representation({ appliedPosition: "42", manifestVersion: 3 }),
    ]);

    const cleared = catalog.publish(3, { representations: [] });

    expect(cleared.representations).toEqual([]);
    expect(cleared.generation).toBe(4);
  });

  it("never resolves a partition at an earlier epoch", () => {
    const { catalog } = openCatalog();

    catalog.publish(1, { defaultWriter: "other" });
    catalog.publish(2, { defaultWriter: "memory" });

    const assigned = catalog.publish(3, { ownership: { orders: "other" } });

    expect(assigned.defaultOwnership).toEqual({ writer: "memory", epoch: 3 });
    expect(assigned.ownership.orders).toEqual({ writer: "other", epoch: 4 });
    expect(resolveWriter(assigned, "tickets")).toEqual({ writer: "memory", epoch: 3 });

    const removed = catalog.publish(4, { removePartitions: ["orders"] });

    expect(resolveWriter(removed, "orders")).toEqual({ writer: "memory", epoch: 5 });
    expect(resolveWriter(removed, "constructor")).toEqual({ writer: "memory", epoch: 3 });

    const moved = catalog.publish(5, { defaultWriter: "other" });

    expect(moved.defaultOwnership).toEqual({ writer: "other", epoch: 4 });
    expect(resolveWriter(moved, "orders")).toEqual({ writer: "other", epoch: 6 });
    expect(resolveWriter(moved, "toString")).toEqual({ writer: "other", epoch: 4 });
  });

  it("rejects a change that does not parse and leaves the current generation in place", () => {
    const { catalog } = openCatalog();

    catalog.publish(1, { ownership: { orders: "memory" } });

    const current = catalog.current();

    expectInvalid(() => catalog.publish(2, {}), /must update ownership or representations/);
    expectInvalid(
      () => catalog.publish(2, { removePartitions: ["orders"], ownership: { orders: "other" } }),
      /cannot be removed and assigned/,
    );
    expectInvalid(() => catalog.publish(2, { removePartitions: ["tickets"] }), /no explicit owner/);
    expectInvalid(
      () => catalog.publish(2, { representations: [representation(), representation()] }),
      /Duplicate read representation/,
    );
    expectInvalid(
      () => catalog.publish(2, { representations: [representation({ schemaVersion: 0 })] }),
      /schemaVersion/,
    );
    expect(catalog.current()).toEqual(current);
  });

  it("rejects a catalog whose default engine cannot be the write authority", () => {
    const registry = registerEngines();

    expectInvalid(() => new Catalog(registry, "missing"), /not registered/);
    expectInvalid(() => new Catalog(registry, "column"), /not a write authority/);
    expectInvalid(() => new Catalog({} as EngineRegistry, "memory"), /EngineRegistry/);
  });
});
