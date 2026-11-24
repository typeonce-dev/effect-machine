import { PgliteClient } from "@effect/sql-pglite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  ShardId,
  Sharding,
  Snowflake,
  SqlMessageStorage
} from "effect/cluster"
import { Digest } from "effect/crypto"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine, SqlMachineStorage } from "../../../src/unstable/cluster/index.js"
import { config } from "./support/harness.js"

const dialects = [
  { name: "SQLite", client: () => SqliteClient.layer({ filename: ":memory:" }) },
  { name: "PostgreSQL", client: () => PgliteClient.layer() }
] as const

const Events = Machine.events({ Add: { amount: Schema.Number } })
const Emitted = Machine.emittedEvents({ Added: { total: Schema.Number } })

const counter = Machine.make({
  id: "SqlCounter",
  root: Machine.state({ states: { Counting: { fields: { total: Schema.Number } } } }),
  events: Events,
  emittedEvents: Emitted
}).handle({
  initial: { target: "Counting", data: { total: 0 } },
  states: {
    Counting: {
      on: {
        Add: {
          branches: [{ target: "Counting" }],
          resolve: ({ event, state, select }, enqueue) => {
            const total = state.total + event.amount
            enqueue.emit(Emitted.Added({ total }))
            return select.target("Counting", { data: { total } })
          }
        }
      }
    }
  }
})

const address = (entityId: string) =>
  EntityAddress.make({
    shardId: ShardId.make("default", 1),
    entityType: EntityType.make("SqlCounter"),
    entityId: EntityId.make(entityId)
  })

const checkpoint = (revision: number): ClusterMachine.Checkpoint => ({
  definitionId: "SqlCounter",
  version: "1",
  revision,
  origin: { _tag: "Request", requestId: Snowflake.Snowflake(String(revision)) },
  snapshot: { path: "", value: { total: revision } } as never,
  status: { _tag: "Active", invocations: {} }
})

const runner = (enqueue: (event: unknown) => Effect.Effect<void, unknown, SqlClient.SqlClient>) => {
  const adapter = ClusterMachine.make("SqlCounter", counter, { version: "1" })
  return {
    adapter,
    layer: adapter.toLayer({ enqueue }).pipe(
      Layer.provideMerge(Sharding.layer),
      Layer.provide(Runners.layerNoop),
      Layer.provideMerge(SqlMessageStorage.layer),
      Layer.provideMerge(SqlMachineStorage.layer),
      Layer.provide(RunnerStorage.layerMemory),
      Layer.provide(RunnerHealth.layerNoop),
      Layer.provide(config()),
      Layer.provide(Digest.layerWebCrypto)
    )
  }
}

for (const dialect of dialects) {
  describe(`SqlMachineStorage on ${dialect.name}`, () => {
    it.effect("keeps the contract of Storage, and rolls back with the transaction of MessageStorage", () =>
      Effect.gen(function*() {
        const storage = yield* SqlMachineStorage.make()
        const messages = yield* MessageStorage.MessageStorage
        yield* ClusterMachine.checkStorage(storage, { withTransaction: messages.withTransaction })
      }).pipe(
        Effect.provide(SqlMessageStorage.layer.pipe(Layer.provide([config(), Digest.layerWebCrypto]))),
        Effect.provide(dialect.client()),
        Effect.orDie
      ))

    it.effect("keeps checkpoints apart by table prefix, and migrates once", () =>
      Effect.gen(function*() {
        const first = yield* SqlMachineStorage.make()
        const again = yield* SqlMachineStorage.make()
        const other = yield* SqlMachineStorage.make({ prefix: "other_machine" })
        assert.strictEqual((yield* first.commit(address("a"), checkpoint(1)))._tag, "Committed")
        assert.strictEqual(Option.getOrThrow(yield* again.load(address("a"))).revision, 1)
        assert.isTrue(Option.isNone(yield* other.load(address("a"))))
        const sql = yield* SqlClient.SqlClient
        const migrated = yield* sql`SELECT * FROM cluster_machine_migrations`
        assert.strictEqual(migrated.length, 1)
      }).pipe(Effect.provide(dialect.client()), Effect.orDie))

    it.effect("stores a step, its emissions, and its reply together, or none of them", () =>
      Effect.gen(function*() {
        const failing = { next: false }
        const { adapter, layer } = runner((event) =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO outbox (event) VALUES (${JSON.stringify(event)})`
            if (failing.next) return yield* Effect.fail("outbox unavailable")
          })
        )
        yield* Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* TestClock.adjust(1)
          const client = (yield* adapter.entity.client)("counter-1")
          const storage = yield* ClusterMachine.Storage

          const accepted = yield* client.send({ _tag: "Add", amount: 2 })
          assert.strictEqual(accepted._tag, "Accepted")

          failing.next = true
          const rejected = yield* client.send({ _tag: "Add", amount: 3 })
          assert.strictEqual(rejected._tag === "Rejected" && rejected.reason, "EmissionFailure")
          const stored = Option.getOrThrow(yield* storage.load(address("counter-1")))
          assert.strictEqual(stored.revision, 1)
          const outbox = yield* sql<{ readonly event: string }>`SELECT event FROM outbox`
          assert.strictEqual(outbox.length, 1)

          failing.next = false
          assert.strictEqual((yield* client.send({ _tag: "Add", amount: 3 }))._tag, "Accepted")
          assert.strictEqual(Option.getOrThrow(yield* storage.load(address("counter-1"))).revision, 2)
          assert.strictEqual((yield* sql`SELECT event FROM outbox`).length, 2)
        }).pipe(Effect.provide(layer))
      }).pipe(
        Effect.provide(
          Layer.effectDiscard(
            Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE TABLE outbox (event TEXT NOT NULL)`)
          ).pipe(Layer.provideMerge(dialect.client()))
        ),
        Effect.orDie
      ))
  })
}
