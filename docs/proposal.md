# LamedDB product and architecture proposal

**LamedDB is a cloud-native database that adapts how it stores, serves, and streams data as usage changes.** Applications use one API to write and query records, publish events, and subscribe to changes. Agents use the hosted Model Context Protocol (MCP) server. LamedDB chooses table layouts, partitioning, storage tiers, encodings, indexes, and query routes across the workload.

The product goal is one service for transactional records, operational analytics, event streams, historical data, and specialized queries. A collection can use several physical layouts while application code uses the same logical operations.

## First customers and launch scope

Start with B2B SaaS teams building bounded workflows such as orders, tickets, or activity. The pilot covers single-record state, filtered lists, exact dashboard totals, and event delivery in one home region through TypeScript, HTTP, and read-only MCP. Teams can adopt it for one workflow and keep their existing store for features that need cross-record transactions or constraints. Dashboards in the pilot use the SDK.

## Developer API

An administrator creates a collection once. Optional field declarations identify types used by queries. Records can carry extra JSON fields. Credentials bind each call to a workspace and tenant. This example uses the proposed SDK in a new collection.

```ts
// Once, with an administrative client
await admin.createCollection("orders", {
  fields: { status: "string", createdAt: "timestamp", totalCents: "integer" },
});

// During normal application use, with tenant-scoped credentials
const orders = db.collection("orders");
const paidAt = "2026-11-19T08:15:00.000Z";
await orders.put("ord_123", {
  status: "paid",
  totalCents: 12900,
  createdAt: paidAt,
}, {
  createOnly: true,
  idempotencyKey: "create-ord-123",
  emit: {
    stream: "order-events",
    event: {
      id: "evt_728", key: "ord_123", type: "order.paid", schemaVersion: 1,
      eventTime: paidAt, data: { orderId: "ord_123" },
    },
  },
});

const order = await orders.get("ord_123");
const where = [
  { field: "status", op: "eq", value: "paid" },
  { field: "createdAt", op: "gte", value: "2026-11-19T00:00:00.000Z" },
  { field: "createdAt", op: "lt", value: "2026-11-20T00:00:00.000Z" },
] as const;

const page = await orders.query({
  where,
  select: ["status", "createdAt", "totalCents"],
  orderBy: [{ field: "createdAt", dir: "desc" }],
  limit: 25,
});

const totals = await orders.query({
  where,
  groupBy: ["status"],
  aggregates: {
    orders: { op: "count" },
    revenueCents: { op: "sum", field: "totalCents" },
  },
});
// totals.groups[0] is { key: { status: "paid" }, orders: "1", revenueCents: "12900" }
```

| SDK operation | HTTP endpoint | Response or effect |
| --- | --- | --- |
| `admin.createCollection(name, spec)` | `POST /v1/collections` | Creates a collection and its optional field declarations. |
| `collection.put(id, data, options?)` | `PUT /v1/collections/{name}/records/{id}` | Creates or fully replaces a record, optionally emits one event, and returns `{ id, version, data }`. |
| `collection.get(id)` | `GET /v1/collections/{name}/records/{id}` | Returns the record and version, or `404`. |
| `collection.delete(id, options?)` | `DELETE /v1/collections/{name}/records/{id}` | Removes a record and returns `204`. An unconditional delete of an absent record also returns `204`. |
| `collection.query(spec)` | `POST /v1/collections/{name}/query` | Returns `{ records, nextCursor }` in list mode or `{ groups }` in aggregate mode. |

### Behavior the engine must preserve

- **Writes and retries.** `createOnly` maps to `If-None-Match: *` on put. `ifVersion` maps to `If-Match` using the `ETag` from a read or put. Failed preconditions return `412`. Use a fresh version on each successful put, including after delete and recreate. `Idempotency-Key` replays the original outcome within the retry window. Bind it to the authorized tenant, method, resource, body including any event, and preconditions. Commit the retry receipt and mutation together, and reject key reuse for a different request.
- **Transaction scope.** A `put` can atomically append one `emit` event to a stream in the same workspace and tenant. The record, event, change entry, retry receipt, and any active rollup commit in one PostgreSQL transaction. Record-key uniqueness is the only application uniqueness guarantee in the pilot. For partial updates use read, merge, and version-checked replacement. General multi-record transactions and additional unique constraints are deferred. [PostgreSQL transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html)
- **Filters and types.** V1 supports top-level fields, AND, scalar equality and membership, typed ranges, `isNull`, and `isMissing`. Missing and null match only their explicit predicates. Undeclared scalar equality and membership are type-sensitive and may scan the tenant's rows subject to the deadline. Range, sort, grouping, and field-based aggregates require declared types. Strings are byte-limited with bytewise ordering, integers fit the JSON safe-integer range, and timestamps use fixed-width UTC millisecond strings. Reject invalid values and unsupported encodings or sizes, normalize integers, and keep declarations fixed during the pilot.
- **Lists.** Each result includes the record ID and version even when `select` projects the document. Sort by the requested declared field and an ascending record ID tie-breaker, or by ascending ID alone. Null and missing sort last. A tamper-resistant cursor binds the tenant, collection, query, and last sort position. Each page is a fresh snapshot, so intervening inserts, updates, and deletes can change later pages. Apply a bounded page size and request deadline.
- **Aggregates.** Support `count` of matching records, `sum` on declared integers, and `min`/`max` on declared ordered types. `sum`, `min`, and `max` ignore missing and null values and return `null` for an empty input. Grouped queries exclude records with missing or null group keys. A query with no group key returns one result, including an exact count of `"0"` for an empty input. Encode counts and sums as decimal strings to preserve integer precision. If a grouped result exceeds its limit, return an explicit error instead of silently truncating it.
- **Consistency.** Reads and exact aggregates use one committed snapshot per request, including writes acknowledged before that request started and subject to later committed changes. A list and an aggregate issued as separate requests can represent different snapshots. Capacity limits surface as explicit errors and timeouts.

## Dynamic storage and cloud architecture

**Layout and placement.** A versioned catalog maps each partition to one write authority. The pilot uses managed PostgreSQL, with a fixed hash of `tenant_id` routing each collection to one of up to eight shared bucket tables. There are no per-tenant tables. Cap a workspace at 16 collections and each collection at one extra migration or rollback table, for at most 144 record tables plus rollups and shared metadata. The first move rewrites packed JSON into typed columns plus residual JSON. [Adaptive engine](multi-engine-plan.md)

**Exact rollup.** Update the pilot's `COUNT` and `SUM` rollup in the same PostgreSQL transaction as each record mutation. Apply deltas from the actual old and new values, including deletes and moves between UTC-day or status buckets. At one primary snapshot, route supported whole-day aggregates to the ready rollup and use authoritative rows for other shapes. Charge the extra writes and hot-bucket contention. Async projections remain candidates for later, if they can merge a complete change tail or serve an explicit staleness contract. [PostgreSQL snapshots](https://www.postgresql.org/docs/18/transaction-iso.html)

**Cutover and rollback.** Backfill a shadow layout while recording changed keys in the write transaction. Writers take a shared transaction lock before reading the current routing epoch. Cutover takes the exclusive lock, drains in-flight writes, reconciles the bounded dirty set, and flips the epoch atomically. Target a pause of at most one second and abort before switching if the budget is exhausted. During the rollback window, mirror writes to the prior table in the same transaction and use the same fence to revert. Copy existing versions and keep receipts and logical feed positions outside layout tables. [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)

**Cloud and recovery.** Run regional request, stream, and migration pools with separate resource budgets. Require verified synchronous durability to the eligible standby and target zero loss of acknowledged work with recovery within five minutes for one availability-zone failure. Target at most five minutes of archive lag and a 60-minute point-in-time restore at pilot scale. Restore catalog, records, receipts, and stream state to one PostgreSQL recovery point and invalidate pre-restore stream cursors. These are drill targets. [Synchronous replication](https://www.postgresql.org/docs/18/warm-standby.html#SYNCHRONOUS-REPLICATION), [PostgreSQL point-in-time recovery](https://www.postgresql.org/docs/18/continuous-archiving.html)

**Planner.** Use measured costs and simple rules for the pilot. Require a minimum projected gain across two evaluation windows, a cooldown, and at most one planned change per partition per rolling hour. Revert automatically during validation when outcomes breach the regression limits. Exempt safety reverts from the change budget. Defer learned cost models until after the pilot. [Planner and migration details](multi-engine-plan.md)

## Streaming, events, and MCP

`orders.changes()` and application streams offer at-least-once delivery, per-partition ordering, and a proposed seven-day replay window. Consumers acknowledge opaque positions per partition and resume from their checkpoint. After expiration, change consumers take a new snapshot and event consumers can restart from the available replay boundary. PostgreSQL assigns the change position by locking and incrementing the partition tail in the mutation transaction, so offsets follow commit order within that partition. [Streaming specification](#streaming-events-and-mcp)

MCP exposes collection discovery, queries, aggregates, and bounded event reads. Enforce tenant and principal rate and concurrency quotas, estimated scan admission, database deadlines, and response caps. Count MCP toward live resource pressure and exclude it from pilot candidate scoring. [MCP specification](#streaming-events-and-mcp)

## Pilot proof

Replay a fixed arrival schedule against a fixed row layout, an index-only adaptive design, a frozen expert design, and the full planner, with identical API, data, load, and resource limits. Use roughly 1 million and 10 million records with cached and uncached working sets. Include tenant skew, writes, live subscribers, event bursts, late events, a bulk import, a lookup-to-analytics shift and return, a held-out shift, and an injected regression.

| Gate | Proposed threshold for the pilot |
| --- | --- |
| Correctness | Require zero tuning-induced result mismatches, lost acknowledged writes or events during cutover or failover, and tenant-scope violations. Verify atomic record and event publication, rollback after new writes, retries, and ordered replay. Check that restore resumes at the selected recovery point. |
| Read performance | Pilot target of half the end-to-end p95 for a predeclared recurring filter and a predeclared exact aggregate versus the fixed row baseline. Report how much of the gain comes from layout and routing by comparing with the index-only design. |
| Foreground safety | At most 10% p99 regression for writes and high-priority point reads at equal offered load during migration and after rollout. Establish workload-specific throughput, timeout, and stream lag budgets before the run. |
| Adaptation and stability | Complete a live layout move and activate the exact rollup. Measure detection, copy, catch-up, pause, recovery, and eligible/routed/fallback shares. Target benefit within 60 minutes for an eligible shift. Near-threshold noise must cause no repeated flips, and an injected regression must trigger automatic reversion. |
| Efficiency | Enforce steady and temporary storage and compute budgets. Charge maintenance, retained logs, duplicates during migration, projection lag, and cloud request costs. Require a positive payback over the declared evaluation horizon. |
| Developer effort | Have a pilot engineer complete the first write, filtered read, and aggregate in under 10 minutes after credentials are issued. Compare active engineering time spent diagnosing and tuning the same workload shift against the team's usual process. |

Stage 2 tests safe migration and exact routing, with latency and cost measured as pilot hypotheses. Stage 3 tests the economic case on a larger cache-exceeding working set. Choose that scale by bytes and workload, with 100 million records as a candidate. Report latency, throughput, errors, write amplification, peak storage, stream lag, and cost across repeated runs, including timeouts and shed requests.

## Build order and storage roadmap

| Stage | Deliverable | Exit criterion |
| --- | --- | --- |
| 1. Cloud foundation | Regional API, transactional records and optional atomic event append, committed change log, replay, and read-only MCP. | The orders workflow passes ordering, authorization, and recovery tests. |
| 2. Adaptive pilot | Live move between two PostgreSQL layouts, a synchronous exact rollup, and one event-time window. | Verify cutover, regression reversion, rollback after new writes, and availability-zone failover under active load. |
| 3. Economic validation | Choose either a sorted-run write path or object-backed cold layout based on pilot bottlenecks. Evaluate tenant-scoped read-only SQL over stable logical views for BI. | Show full-cost payback at the larger scale. Validate a BI connector end to end before claiming compatibility. [Power BI PostgreSQL connector](https://learn.microsoft.com/en-us/power-query/connectors/postgresql) |
| 4. Conditional expansion | Prioritize text search and time-series queries after stage 3 shows payback and customers validate demand. | Qualify supported operator and layout pairs and retain an eligible route for every enabled operation. |
