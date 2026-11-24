import { describe, expect, it } from "vitest";

import {
  Catalog,
  CollectionService,
  ENGINE_OPERATIONS,
  EngineRegistry,
  LamedError,
  MemoryStore,
  Router,
  SINGLE_STORE_ENGINE_ID,
  memoryStoreDescriptor,
  resolveWriter,
  type CollectionServiceOptions,
  type EngineOperation,
  type EngineStore,
  type LogicalRequest,
  type ReadRepresentation,
  type Store,
} from "../src/index.js";
import { startTestServer, TEST_API_KEY } from "./helpers.js";

function logical(operation: EngineOperation, collection = "orders"): LogicalRequest {
  return {
    operation,
    collection,
    scope: "default",
    consistency: "strong",
  };
}

function countingStore(): { store: EngineStore; calls: () => number } {
  let count = 0;
  const touch = async (): Promise<never> => {
    count += 1;

    throw new Error("store was called");
  };
  const store = {
    createCollection: touch,
    getCollection: touch,
    deleteCollection: touch,
    putRecord: touch,
    getRecord: touch,
    deleteRecord: touch,
    listRecords: touch,
  } as EngineStore;

  return { store, calls: () => count };
}

function registerPair(): {
  registry: EngineRegistry;
  memory: MemoryStore;
  other: MemoryStore;
  catalog: Catalog;
  router: Router;
} {
  const registry = new EngineRegistry();
  const memory = new MemoryStore();
  const other = new MemoryStore();

  registry.register("memory", memory, memoryStoreDescriptor());
  registry.register("other", other, memoryStoreDescriptor());

  const catalog = new Catalog(registry, "memory");

  return { registry, memory, other, catalog, router: new Router(registry, catalog) };
}

function expectInvalid(run: () => void, message: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LamedError);

    const rejected = error as LamedError;

    expect(rejected.code).toBe("invalid_argument");
    expect(rejected.status).toBe(400);
    expect(rejected.message).toMatch(message);

    return;
  }

  throw new Error("expected the call to throw");
}

async function runUseCase(service: CollectionService, operation: EngineOperation): Promise<unknown> {
  switch (operation) {
    case "createCollection":
      return service.createCollection("orders", { fields: { status: "string" } });
    case "getCollection":
      return undefined;
    case "deleteCollection":
      return service.deleteCollection("orders");
    case "putRecord":
      return service.putRecord("orders", "ord_1", { status: "open" });
    case "getRecord":
      return service.getRecord("orders", "ord_1");
    case "deleteRecord":
      return service.deleteRecord("orders", "ord_1");
    case "listRecords":
      return service.listRecords("orders");
    default: {
      const exhaustive: never = operation;

      return exhaustive;
    }
  }
}

interface Exchange {
  status: number;
  body: unknown;
  etag: string | null;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Exchange> {
  const headers = new Headers({ authorization: `Bearer ${TEST_API_KEY}` });

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
    etag: response.headers.get("etag"),
  };
}

async function collectionScript(
  baseUrl: string,
  name: string,
  afterPut?: () => Promise<void>,
): Promise<Exchange[]> {
  const root = `/v1/collections/${name}`;
  const record = `${root}/records/a`;
  const document = { status: "paid", totalCents: 100 };
  const replaced = { status: "open", totalCents: 50 };
  const steps: Exchange[] = [];

  steps.push(
    await call(baseUrl, "POST", "/v1/collections", {
      name,
      fields: { status: "string", totalCents: "integer" },
    }),
  );
  steps.push(await call(baseUrl, "PUT", record, document, { "idempotency-key": `${name}-a` }));

  if (afterPut !== undefined) {
    await afterPut();
  }

  steps.push(await call(baseUrl, "PUT", record, document, { "idempotency-key": `${name}-a` }));
  steps.push(await call(baseUrl, "GET", record));
  steps.push(await call(baseUrl, "GET", `${root}/records?limit=10&filter[status]=paid`));
  steps.push(await call(baseUrl, "PUT", record, replaced, { "if-match": '"1"' }));
  steps.push(await call(baseUrl, "GET", `${root}/records?limit=10&filter[status]=paid`));
  steps.push(await call(baseUrl, "DELETE", record));
  steps.push(await call(baseUrl, "DELETE", root));

  return steps;
}

describe("request router", () => {
  it("routes each collection to the writer resolveWriter reports", () => {
    const { memory, other, catalog, router } = registerPair();

    catalog.publish(1, { ownership: { tickets: "other" } });

    const orders = router.resolve(logical("putRecord", "orders"));
    const tickets = router.resolve(logical("getRecord", "tickets"));
    const pinned = catalog.current();

    expect(orders.store).toBe(memory);
    expect(tickets.store).toBe(other);
    expect(orders).toMatchObject({
      engineId: resolveWriter(pinned, "orders").writer,
      generation: pinned.generation,
      epoch: resolveWriter(pinned, "orders").epoch,
    });
    expect(tickets).toMatchObject({
      engineId: resolveWriter(pinned, "tickets").writer,
      generation: pinned.generation,
      epoch: resolveWriter(pinned, "tickets").epoch,
    });
    expect(orders.engineId).toBe("memory");
    expect(tickets.engineId).toBe("other");
    expect(router.resolve(logical("getRecord", "constructor"))).toMatchObject({
      engineId: resolveWriter(pinned, "constructor").writer,
      epoch: resolveWriter(pinned, "constructor").epoch,
    });
    expect(router.resolve(logical("getRecord", "toString")).epoch).toBe(resolveWriter(pinned, "toString").epoch);
  });

  it("keeps the pinned generation when a later publish moves the writer", () => {
    const { catalog, router } = registerPair();
    const request = logical("getRecord");
    const first = router.resolve(request);

    catalog.publish(1, { ownership: { orders: "other" } });

    const second = router.resolve(request);

    expect(first).toMatchObject({ engineId: "memory", generation: 1, epoch: 1 });
    expect(second).toMatchObject({ engineId: "other", generation: 2, epoch: 2 });
    expect(first.generation).toBe(1);
  });

  it("does not call the store when the engine does not list the operation", async () => {
    for (const operation of ENGINE_OPERATIONS) {
      const counted = countingStore();
      const descriptor = memoryStoreDescriptor();

      descriptor.operations = ENGINE_OPERATIONS.filter((item) => item !== operation);

      const registry = new EngineRegistry();

      registry.register("memory", counted.store, descriptor);

      const router = new Router(registry, new Catalog(registry, "memory"));
      let routed = false;

      expect(() => router.resolve(logical(operation))).toThrow(
        expect.objectContaining({
          code: "internal",
          status: 500,
          message: `No qualified route for operation "${operation}".`,
        }),
      );

      if (operation !== "getCollection") {
        await expect(
          runUseCase(
            new CollectionService(router, {
              onRoute() {
                routed = true;
              },
            }),
            operation,
          ),
        ).rejects.toMatchObject({
          code: "internal",
          status: 500,
          message: `No qualified route for operation "${operation}".`,
        });
      }

      expect(counted.calls()).toBe(0);
      expect(routed).toBe(false);
    }
  });

  it("rejects a catalog that does not use the router's registry", () => {
    const catalogRegistry = new EngineRegistry();
    const sameIdRegistry = new EngineRegistry();
    const otherIdRegistry = new EngineRegistry();
    const memory = countingStore();
    const sameId = countingStore();
    const decoy = countingStore();

    catalogRegistry.register("memory", memory.store, memoryStoreDescriptor());
    sameIdRegistry.register("memory", sameId.store, memoryStoreDescriptor());
    otherIdRegistry.register("other", decoy.store, memoryStoreDescriptor());

    const catalog = new Catalog(catalogRegistry, "memory");

    expectInvalid(() => new Router(sameIdRegistry, catalog), /same registry/);
    expectInvalid(() => new Router(otherIdRegistry, catalog), /same registry/);
    expect(memory.calls()).toBe(0);
    expect(sameId.calls()).toBe(0);
    expect(decoy.calls()).toBe(0);
    expect(new Router(catalogRegistry, catalog).resolve(logical("getRecord")).store).toBe(memory.store);
  });

  it("does not call storage when a record engine omits getCollection", async () => {
    const recordOperations = ["putRecord", "getRecord", "deleteRecord", "listRecords"] as const;

    for (const operation of recordOperations) {
      for (const hideGetCollection of [false, true]) {
        let calls = 0;
        const touch = async (): Promise<never> => {
          calls += 1;

          throw new Error("store was called");
        };
        const store = {
          createCollection: touch,
          deleteCollection: touch,
          putRecord: touch,
          getRecord: touch,
          deleteRecord: touch,
          listRecords: touch,
          ...(hideGetCollection ? {} : { getCollection: touch }),
        } as EngineStore;
        const descriptor = memoryStoreDescriptor();

        descriptor.operations = ENGINE_OPERATIONS.filter((item) => item !== "getCollection");

        const registry = new EngineRegistry();

        registry.register("memory", store, descriptor);

        let routed = false;
        const service = new CollectionService(new Router(registry, new Catalog(registry, "memory")), {
          onRoute() {
            routed = true;
          },
        });

        await expect(runUseCase(service, operation)).rejects.toMatchObject({
          code: "internal",
          status: 500,
          message: 'No qualified route for operation "getCollection".',
        });
        expect(calls).toBe(0);
        expect(routed).toBe(false);
      }
    }

    let reads = 0;
    const creating = {
      createCollection: async (name: string) => ({ name, fields: { status: "string" } }),
      getCollection: async () => {
        reads += 1;

        return null;
      },
    } as EngineStore;
    const descriptor = memoryStoreDescriptor();

    descriptor.operations = ["createCollection"];

    const registry = new EngineRegistry();

    registry.register("memory", creating, descriptor);

    const service = new CollectionService(new Router(registry, new Catalog(registry, "memory")));

    await expect(service.createCollection("orders", { fields: { status: "string" } })).resolves.toMatchObject({
      name: "orders",
    });
    expect(reads).toBe(0);
  });

  it("rejects a logical request that is not the documented shape and leaves the catalog unchanged", () => {
    const { catalog, router } = registerPair();
    const before = catalog.current();
    const valid = logical("getRecord");

    expectInvalid(() => router.resolve(undefined as unknown as LogicalRequest), /must be an object/);
    expectInvalid(() => router.resolve([] as unknown as LogicalRequest), /must be an object/);
    expectInvalid(() => router.resolve({ ...valid, extra: true } as LogicalRequest), /Unknown logical request field/);
    expectInvalid(() => router.resolve({ ...valid, operation: "dropCollection" } as unknown as LogicalRequest), /operation/);
    expectInvalid(() => router.resolve({ ...valid, scope: "tenant" } as unknown as LogicalRequest), /scope/);
    expectInvalid(() => router.resolve({ ...valid, consistency: "eventual" } as unknown as LogicalRequest), /consistency/);
    expectInvalid(() => router.resolve({ ...valid, collection: "" }), /not allowed/);
    expectInvalid(() => router.resolve({ ...valid, deadline: -1 }), /deadline/);
    expectInvalid(() => router.resolve({ ...valid, deadline: 1.5 }), /deadline/);
    expectInvalid(() => router.resolve({ ...valid, deadline: "soon" } as unknown as LogicalRequest), /deadline/);

    const hidden = { ...valid };

    Object.defineProperty(hidden, "note", { value: true, enumerable: false });
    expectInvalid(() => router.resolve(hidden), /Unknown logical request field/);

    const symbolic = { ...valid };

    Object.defineProperty(symbolic, Symbol("extra"), { value: true });
    expectInvalid(() => router.resolve(symbolic), /Unknown logical request field/);
    expect(catalog.current()).toEqual(before);
    expect(router.resolve({ ...valid, deadline: 0 })).toMatchObject({
      engineId: "memory",
      generation: 1,
      epoch: 1,
    });
  });

  it("never moves a partition epoch backwards when its owner is removed and added again", () => {
    const { catalog, router } = registerPair();
    const request = logical("getRecord");
    const seen: Array<{ engineId: string; epoch: number }> = [];

    const capture = (): void => {
      const generation = catalog.current();
      const route = router.resolve(request);
      const writer = resolveWriter(generation, "orders");

      expect(route.engineId).toBe(writer.writer);
      expect(route.epoch).toBe(writer.epoch);
      expect(route.generation).toBe(generation.generation);
      seen.push({ engineId: route.engineId, epoch: route.epoch });
    };

    capture();
    catalog.publish(1, { ownership: { orders: "other" } });
    capture();
    catalog.publish(2, { removePartitions: ["orders"] });

    const removedGeneration = catalog.current();

    capture();
    expect(removedGeneration.ownership.orders).toBeUndefined();
    expect(removedGeneration.defaultOwnership).toEqual({ writer: "memory", epoch: 1 });
    expect(seen[2]?.epoch).toBeGreaterThan(removedGeneration.defaultOwnership.epoch);
    expect(seen[2]?.engineId).toBe("memory");

    catalog.publish(3, { ownership: { orders: "other" } });
    capture();

    expect(seen).toEqual([
      { engineId: "memory", epoch: 1 },
      { engineId: "other", epoch: 2 },
      { engineId: "memory", epoch: 3 },
      { engineId: "other", epoch: 4 },
    ]);

    for (let index = 1; index < seen.length; index += 1) {
      const previous = seen[index - 1];
      const current = seen[index];

      expect(current?.epoch).toBeGreaterThanOrEqual(previous?.epoch ?? 0);
    }
  });

  it("uses one generation for the collection read and the following write", async () => {
    const fixture = pinOnRead();

    await fixture.service.createCollection("orders", { fields: { status: "string" } });
    fixture.routes.length = 0;
    fixture.arm();

    const written = await fixture.service.putRecord("orders", "ord_1", { status: "paid" });

    expect(written).toEqual({
      created: true,
      record: { id: "ord_1", version: 1, data: { status: "paid" } },
    });
    expect(fixture.routes).toEqual([{ engineId: "primary", generation: 1, epoch: 1 }]);
    expect(await fixture.primary.getRecord("orders", "ord_1")).toEqual(written.record);
    expect(await fixture.secondary.getCollection("orders")).toBeNull();
    await expect(fixture.service.getRecord("orders", "ord_1")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(fixture.routes[1]).toEqual({ engineId: "secondary", generation: 2, epoch: 2 });
    expect(await fixture.primary.getRecord("orders", "ord_1")).toEqual(written.record);
  });

  it("uses one generation for the collection read and the following list", async () => {
    const fixture = pinOnRead();

    await fixture.service.createCollection("orders", { fields: { status: "string" } });
    await fixture.service.putRecord("orders", "ord_1", { status: "paid" });
    fixture.routes.length = 0;
    fixture.arm();

    const page = await fixture.service.listRecords("orders");

    expect(page.records.map((record) => record.id)).toEqual(["ord_1"]);
    expect(fixture.routes).toEqual([{ engineId: "primary", generation: 1, epoch: 1 }]);
    expect(await fixture.secondary.getCollection("orders")).toBeNull();
    await expect(fixture.service.listRecords("orders")).rejects.toMatchObject({ code: "not_found" });
    expect(fixture.routes[1]).toEqual({ engineId: "secondary", generation: 2, epoch: 2 });
  });

  it("reports the engine, generation, and epoch once per use case", async () => {
    const registry = new EngineRegistry();
    const orders = new MemoryStore();
    const tickets = new MemoryStore();

    registry.register("orders-db", orders, memoryStoreDescriptor());
    registry.register("tickets-db", tickets, memoryStoreDescriptor());

    const catalog = new Catalog(registry, "orders-db");

    catalog.publish(1, { ownership: { tickets: "tickets-db" } });

    const seen: Array<{ engineId: string; generation: number; epoch: number }> = [];
    const service = new CollectionService(new Router(registry, catalog), {
      onRoute(route) {
        seen.push({ engineId: route.engineId, generation: route.generation, epoch: route.epoch });
      },
    });

    await service.createCollection("orders", { fields: { status: "string" } });
    await service.createCollection("tickets", { fields: { status: "string" } });
    await service.putRecord("orders", "ord_1", { status: "paid" });
    await service.putRecord("tickets", "tic_1", { status: "open" });
    await service.getRecord("orders", "ord_1");
    await service.listRecords("tickets");
    await service.deleteRecord("orders", "ord_1");
    await service.deleteCollection("tickets");
    await expect(service.getRecord("missing", "a")).rejects.toMatchObject({ code: "not_found" });

    expect(seen).toEqual([
      { engineId: "orders-db", generation: 2, epoch: 1 },
      { engineId: "tickets-db", generation: 2, epoch: 2 },
      { engineId: "orders-db", generation: 2, epoch: 1 },
      { engineId: "tickets-db", generation: 2, epoch: 2 },
      { engineId: "orders-db", generation: 2, epoch: 1 },
      { engineId: "tickets-db", generation: 2, epoch: 2 },
      { engineId: "orders-db", generation: 2, epoch: 1 },
      { engineId: "tickets-db", generation: 2, epoch: 2 },
      { engineId: "orders-db", generation: 2, epoch: 1 },
    ]);
  });

  it("serves disjoint collections from their owners and matches a single-store server", async () => {
    const ordersStore = new MemoryStore();
    const ticketsStore = new MemoryStore();
    const registry = new EngineRegistry();

    registry.register("orders-db", ordersStore, memoryStoreDescriptor());
    registry.register("tickets-db", ticketsStore, memoryStoreDescriptor());

    const catalog = new Catalog(registry, "orders-db");

    catalog.publish(1, { ownership: { tickets: "tickets-db" } });

    const seen: string[] = [];
    const multi = await startTestServer({
      service: new CollectionService(new Router(registry, catalog), {
        onRoute(route) {
          seen.push(route.engineId);
        },
      }),
    });
    const ordersOnly = await startTestServer();
    const ticketsOnly = await startTestServer();

    try {
      const ordersFromMulti = await collectionScript(multi.server.url, "orders", async () => {
        expect(await ordersStore.getRecord("orders", "a")).toMatchObject({ id: "a", version: 1 });
        expect(await ticketsStore.getCollection("orders")).toBeNull();
        expect(await ticketsStore.getCollection("tickets")).toBeNull();
      });
      const ticketsFromMulti = await collectionScript(multi.server.url, "tickets", async () => {
        expect(await ticketsStore.getRecord("tickets", "a")).toMatchObject({ id: "a", version: 1 });
        expect(await ordersStore.getCollection("tickets")).toBeNull();
      });
      const ordersFromSingle = await collectionScript(ordersOnly.server.url, "orders");
      const ticketsFromSingle = await collectionScript(ticketsOnly.server.url, "tickets");

      expect(ordersFromMulti).toEqual(ordersFromSingle);
      expect(ticketsFromMulti).toEqual(ticketsFromSingle);
      expect(ordersFromMulti.map((step) => step.status)).toEqual([201, 201, 201, 200, 200, 200, 200, 204, 204]);
      expect(seen.filter((engineId) => engineId === "orders-db")).toHaveLength(9);
      expect(seen.filter((engineId) => engineId === "tickets-db")).toHaveLength(9);
      expect(seen.slice(0, 9).every((engineId) => engineId === "orders-db")).toBe(true);
      expect(seen.slice(9).every((engineId) => engineId === "tickets-db")).toBe(true);
    } finally {
      await multi.server.close();
      await ordersOnly.server.close();
      await ticketsOnly.server.close();
    }
  });

  it("keeps a full-record read on the owner when a derived representation is published", async () => {
    const owner = new MemoryStore();
    let columnCalls = 0;
    const column = {
      async getCollection() {
        columnCalls += 1;

        return null;
      },
      async getRecord() {
        columnCalls += 1;

        return null;
      },
      async listRecords() {
        columnCalls += 1;

        return { records: [], hasMore: false };
      },
    } as EngineStore;
    const descriptor = memoryStoreDescriptor();

    descriptor.kind = "column";
    descriptor.roles = ["derived-read"];
    descriptor.operations = ["getCollection", "getRecord", "listRecords"];
    descriptor.exactness = "exact";

    const registry = new EngineRegistry();

    registry.register("memory", owner, memoryStoreDescriptor());
    registry.register("column", column, descriptor);

    const catalog = new Catalog(registry, "memory");
    const representation: ReadRepresentation = {
      engine: "column",
      collection: "orders",
      fields: ["status"],
      schemaVersion: 1,
      sourceGeneration: 1,
    };

    catalog.publish(1, { representations: [representation] });

    const service = new CollectionService(new Router(registry, catalog));

    await service.createCollection("orders", { fields: { status: "string" } });
    await service.putRecord("orders", "ord_1", { status: "paid" });

    await expect(service.getRecord("orders", "ord_1")).resolves.toMatchObject({
      id: "ord_1",
      data: { status: "paid" },
    });
    await expect(service.listRecords("orders")).resolves.toMatchObject({
      records: [{ id: "ord_1" }],
    });
    expect(columnCalls).toBe(0);
    expect(await owner.getRecord("orders", "ord_1")).toMatchObject({ id: "ord_1" });
  });

  it("checks the bearer token before routing or touching storage", async () => {
    const counted = countingStore();
    const registry = new EngineRegistry();

    registry.register("memory", counted.store, memoryStoreDescriptor());

    let routes = 0;
    const running = await startTestServer({
      service: new CollectionService(new Router(registry, new Catalog(registry, "memory")), {
        onRoute() {
          routes += 1;
        },
      }),
    });

    try {
      const missing = await fetch(`${running.server.url}/v1/collections/orders/records/a`, { method: "PUT" });
      const wrong = await fetch(`${running.server.url}/v1/collections/orders/records/a`, {
        method: "PUT",
        headers: { authorization: "Bearer wrong-key", "content-type": "application/json" },
        body: JSON.stringify({ status: "paid" }),
      });
      const health = await fetch(`${running.server.url}/health`);

      expect(missing.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(health.status).toBe(200);
      await expect(missing.json()).resolves.toEqual({
        error: { code: "unauthenticated", message: "A valid API key is required." },
      });
      expect(counted.calls()).toBe(0);
      expect(routes).toBe(0);
    } finally {
      await running.server.close();
    }
  });

  it("rejects a router or service built from the wrong objects", async () => {
    const { registry, catalog } = registerPair();

    expectInvalid(() => new Router({} as EngineRegistry, catalog), /EngineRegistry/);
    expectInvalid(() => new Router(registry, {} as Catalog), /Catalog/);
    expectInvalid(
      () => new CollectionService(null as unknown as Store),
      /Engine store must be an object/,
    );

    const symbolOptions: CollectionServiceOptions = {};

    Object.defineProperty(symbolOptions, Symbol("extra"), { value: true });
    expectInvalid(() => new CollectionService(new MemoryStore(), symbolOptions), /Unknown service option/);
    expectInvalid(
      () => new CollectionService(new MemoryStore(), { onRoute: "no" } as unknown as CollectionServiceOptions),
      /onRoute must be a function/,
    );
    expectInvalid(
      () => new CollectionService(new MemoryStore(), { extra: true } as unknown as CollectionServiceOptions),
      /Unknown service option/,
    );
    expectInvalid(() => new CollectionService(new MemoryStore(), [] as unknown as CollectionServiceOptions), /options/);

    const seen: string[] = [];
    const wrapped = new CollectionService(new MemoryStore(), {
      onRoute(route) {
        seen.push(route.engineId);
      },
    });

    await wrapped.createCollection("orders", { fields: { status: "string" } });
    expect(seen).toEqual([SINGLE_STORE_ENGINE_ID]);
  });
});

interface PinFixture {
  service: CollectionService;
  primary: MemoryStore;
  secondary: MemoryStore;
  routes: Array<{ engineId: string; generation: number; epoch: number }>;
  arm(): void;
}

function pinOnRead(): PinFixture {
  const primary = new MemoryStore();
  const secondary = new MemoryStore();
  const registry = new EngineRegistry();
  const holder: { catalog?: Catalog } = {};
  let armed = false;
  const gate: Store = {
    createCollection: (name, fields, aliases) => primary.createCollection(name, fields, aliases),
    async getCollection(name) {
      const found = await primary.getCollection(name);
      const catalog = holder.catalog;

      if (armed && catalog !== undefined && name === "orders") {
        armed = false;
        catalog.publish(catalog.current().generation, { ownership: { orders: "secondary" } });
      }

      return found;
    },
    deleteCollection: (name) => primary.deleteCollection(name),
    putRecord: (input) => primary.putRecord(input),
    getRecord: (collection, id) => primary.getRecord(collection, id),
    deleteRecord: (collection, id) => primary.deleteRecord(collection, id),
    listRecords: (input) => primary.listRecords(input),
  };

  registry.register("primary", gate, memoryStoreDescriptor());
  registry.register("secondary", secondary, memoryStoreDescriptor());

  const catalog = new Catalog(registry, "primary");

  holder.catalog = catalog;

  const routes: PinFixture["routes"] = [];
  const service = new CollectionService(new Router(registry, catalog), {
    onRoute(route) {
      routes.push({ engineId: route.engineId, generation: route.generation, epoch: route.epoch });
    },
  });

  return {
    service,
    primary,
    secondary,
    routes,
    arm() {
      armed = true;
    },
  };
}
