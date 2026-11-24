import { PgliteClient } from "@effect/sql-pglite"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import {
  ClusterError,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  Snowflake,
  SqlMessageStorage
} from "effect/cluster"
import { Digest } from "effect/crypto"
import * as SqlClient from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine, SqlMachineStorage } from "../../../src/unstable/cluster/index.js"
import { config, makeMessages, makeTestStorage, storageKey, type TestStorage } from "./support/harness.js"

const dialects: ReadonlyArray<{
  readonly name: string
  readonly client: () => Layer.Layer<SqlClient.SqlClient, SqlError>
}> = [
  { name: "SQLite", client: () => SqliteClient.layer({ filename: ":memory:" }) },
  { name: "PostgreSQL", client: () => PgliteClient.layer() }
]

const Ledger = ClusterMachine.make(
  "Ledger",
  Machine.make({
    root: Machine.state({ states: { Open: { fields: { total: Schema.Number } } } }),
    events: Machine.events({ Add: { amount: Schema.Number } })
  }).handle({
    initial: { target: "Open", data: { total: 0 } },
    states: {
      Open: { on: { Add: { update: { Open: ({ event, state }) => ({ total: state.total + event.amount }) } } } }
    }
  }),
  { version: "1" }
)

// A target that no Cluster adapter made, as a local reference is.
const local: Machine.MachineTarget<unknown> = { id: "Local", sessionId: "local-1", send: () => Effect.void }

const OrderEvents = Machine.events({
  Pay: { amount: Schema.Number },
  Overpay: {},
  PayLocally: {},
  Report: {},
  Ask: {},
  Answer: {}
})

const order = Machine.make({
  root: Machine.state({ states: { Open: {}, Paid: {}, Reporting: {}, Asked: {}, Answered: {} } }),
  events: OrderEvents,
  effects: {
    // Sends from work, through the target.
    report: (sessionId: string) =>
      Effect.orDie(Ledger.target("ledger-1").send({ _tag: "Add", amount: sessionId.length }))
  }
}).handle({
  initial: { target: "Open" },
  states: {
    Open: {
      on: {
        Pay: {
          target: "Paid",
          commands: ({ event }, enqueue) => {
            enqueue.sendTo(Ledger.target("ledger-1"), { _tag: "Add", amount: event.amount })
            enqueue.sendTo(Ledger.target("ledger-2"), { _tag: "Add", amount: 1 })
          }
        },
        Overpay: {
          target: "Paid",
          // The types cannot see an amount that is not a number, which the target refuses.
          commands: (_, enqueue) => enqueue.sendTo(Ledger.target("ledger-1"), { _tag: "Add", amount: "all" } as never)
        },
        PayLocally: { target: "Paid", commands: (_, enqueue) => enqueue.sendTo(local, {}) },
        Report: { target: "Reporting" },
        Ask: { target: "Asked", commands: ({ self }, enqueue) => enqueue.sendTo(self, { _tag: "Answer" }) }
      }
    },
    Paid: {},
    Reporting: { invoke: { src: "report", input: ({ self }) => self.sessionId, onDone: { target: "Paid" } } },
    Asked: { on: { Answer: { target: "Answered" } } },
    Answered: {}
  }
})

const Order = ClusterMachine.make("Order", order, { version: "1" })

/** Lets everything that does not wait for time happen. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })

const start = Effect.fnUntraced(function*() {
  const storage = makeTestStorage()
  const messages = yield* makeMessages
  yield* TestClock.adjust("1 second")
  const scope = yield* Scope.fork(yield* Effect.scope)
  const context = yield* Layer.mergeAll(Order.toLayer(), Ledger.toLayer()).pipe(
    Layer.provide(Layer.succeed(ClusterMachine.Storage, storage.service)),
    Layer.provideMerge(Sharding.layer),
    Layer.provide(Runners.layerNoop),
    Layer.provide(
      Layer.succeed(MessageStorage.MessageStorage, messages.storage)
    ),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(config()),
    Layer.buildWithScope(scope)
  )
  yield* TestClock.adjust(1)
  const orders = (yield* Effect.provideContext(Order.client, context))("order-1")
  return { storage, messages, orders, sharding: Context.get(context, Sharding.Sharding) }
})

const totalOf = (storage: TestStorage, ledger: string) =>
  storage.entries.get(storageKey("Ledger", ledger))?.snapshot.active.at(-1)?.value
const leafOf = (storage: TestStorage) =>
  storage.entries.get(storageKey("Order", "order-1"))?.snapshot.active.at(-1)?.path

type Driver = MessageStorage.MemoryDriver["Service"]
const sendsTo = (driver: Driver, entityType: string) =>
  driver.journal.filter((envelope) =>
    envelope._tag === "Request" && envelope.tag === "send" && envelope.address.entityType === entityType
  )

describe("ClusterMachine machines that send to each other", () => {
  it.effect("save what a step sends with its checkpoint, and apply it once", () =>
    Effect.gen(function*() {
      const { messages, orders, sharding, storage } = yield* start()
      yield* orders.send({ _tag: "Pay", amount: 5 })
      yield* settle
      assert.strictEqual(leafOf(storage), "Paid")
      assert.deepStrictEqual(totalOf(storage, "ledger-1"), { _tag: "Open", total: 5 })
      assert.deepStrictEqual(totalOf(storage, "ledger-2"), { _tag: "Open", total: 1 })
      const sent = sendsTo(messages.driver, "Ledger")
      assert.deepStrictEqual(
        sent.map((envelope) => envelope._tag === "Request" && [envelope.address.entityId, envelope.payload]),
        [["ledger-1", { _tag: "Add", amount: 5 }], ["ledger-2", { _tag: "Add", amount: 1 }]]
      )
      // A request that Cluster delivers again is recognized by its id.
      const first = sent[0]
      assert.isTrue(first?._tag === "Request")
      if (first?._tag !== "Request") return
      const commits = storage.commits
      yield* messages.storage.clearReplies(Snowflake.Snowflake(first.requestId))
      yield* sharding.pollStorage
      yield* settle
      assert.lengthOf(Array.from(messages.driver.unprocessed).filter((envelope) => envelope._tag === "Request"), 0)
      assert.strictEqual(storage.commits, commits)
      assert.deepStrictEqual(totalOf(storage, "ledger-1"), { _tag: "Open", total: 5 })
    }).pipe(Effect.scoped))

  it.effect("reject a step that sends an event its target refuses", () =>
    Effect.gen(function*() {
      const { messages, orders, storage } = yield* start()
      const rejected = yield* Effect.flip(orders.send({ _tag: "Overpay" }))
      assert.strictEqual(rejected._tag === "Rejected" && rejected.reason, "TransitionFailure")
      assert.match(rejected._tag === "Rejected" ? rejected.message : "", /sends Ledger\/ledger-1 an event it refuses/)
      assert.strictEqual(leafOf(storage), undefined)
      assert.lengthOf(sendsTo(messages.driver, "Ledger"), 0)
    }).pipe(Effect.scoped))

  it.effect("reject a step that sends to a target that is not a Cluster machine", () =>
    Effect.gen(function*() {
      const { orders, storage } = yield* start()
      const rejected = yield* Effect.flip(orders.send({ _tag: "PayLocally" }))
      assert.strictEqual(rejected._tag === "Rejected" && rejected.reason, "UnsupportedProcessLocal")
      assert.strictEqual(leafOf(storage), undefined)
    }).pipe(Effect.scoped))

  it.effect("send to itself through `self`, in a later step", () =>
    Effect.gen(function*() {
      const { messages, orders, storage } = yield* start()
      yield* orders.send({ _tag: "Ask" })
      yield* settle
      assert.strictEqual(leafOf(storage), "Answered")
      assert.lengthOf(sendsTo(messages.driver, "Order").filter((envelope) => envelope._tag === "Request"), 2)
    }).pipe(Effect.scoped))

  it.effect("send from work, which names its own entity by its address", () =>
    Effect.gen(function*() {
      const { orders, storage } = yield* start()
      yield* orders.send({ _tag: "Report" })
      yield* settle
      assert.strictEqual(leafOf(storage), "Paid")
      // `self.sessionId` of the order is "Order/order-1".
      assert.deepStrictEqual(totalOf(storage, "ledger-1"), { _tag: "Open", total: "Order/order-1".length })
    }).pipe(Effect.scoped))

  it.effect("name a target by its entity type and id", () =>
    Effect.sync(() => {
      const target = Ledger.target("ledger-1")
      assert.deepStrictEqual(
        [target.entityType, target.entityId, target.id, target.sessionId],
        ["Ledger", "ledger-1", "Ledger", "Ledger/ledger-1"]
      )
    }))

  it.effect("send through a target only where a Cluster runner is", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Ledger.target("ledger-1").send({ _tag: "Add", amount: 1 }))
      assert.isTrue(Exit.isFailure(exit) && Exit.hasDies(exit))
    }))

  for (const dialect of dialects) {
    it.effect(`roll back what a step sends with its checkpoint, on ${dialect.name}`, () => {
      let failing = true
      // Fails the transaction of the step once the event it sends is saved.
      const messageStorage = Layer.effect(
        MessageStorage.MessageStorage,
        Effect.map(MessageStorage.MessageStorage, (storage) =>
          MessageStorage.MessageStorage.of({
            ...storage,
            saveRequest: (message) =>
              Effect.tap(
                storage.saveRequest(message),
                () =>
                  failing && message.envelope.address.entityType === "Ledger"
                    ? Effect.fail(new ClusterError.PersistenceError({ cause: new Error("broken after the save") }))
                    : Effect.void
              )
          }))
      ).pipe(Layer.provideMerge(SqlMessageStorage.layer))
      const layer = Layer.mergeAll(Order.toLayer(), Ledger.toLayer()).pipe(
        Layer.provideMerge(Sharding.layer),
        Layer.provide(Runners.layerNoop),
        Layer.provideMerge(messageStorage),
        Layer.provideMerge(SqlMachineStorage.layer),
        Layer.provide(RunnerStorage.layerMemory),
        Layer.provide(RunnerHealth.layerNoop),
        Layer.provide(config()),
        Layer.provide(Digest.layerWebCrypto),
        Layer.provideMerge(dialect.client())
      )
      return Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const orders = (yield* Order.client)("order-1")
        const ledgers = (yield* Ledger.client)("ledger-1")
        const sql = yield* SqlClient.SqlClient
        const saved = sql<{ readonly count: number | string }>`
          SELECT COUNT(*) AS count FROM cluster_messages WHERE entity_type = 'Ledger'
        `.pipe(Effect.map((rows) => Number(rows[0]?.count)))

        const rejected = yield* Effect.flip(orders.send({ _tag: "Pay", amount: 5 }))
        assert.strictEqual(rejected._tag === "Rejected" && rejected.reason, "PersistenceFailure")
        assert.isTrue(Option.isNone(yield* orders.snapshot))
        assert.strictEqual(yield* saved, 0)

        failing = false
        yield* orders.send({ _tag: "Pay", amount: 5 })
        assert.strictEqual(yield* saved, 2)
        yield* TestClock.adjust("1 second")
        const ledger = yield* ledgers.snapshot
        assert.include(JSON.stringify(Option.getOrThrow(ledger).state), `{"_tag":"Open","total":5}`)
      }).pipe(Effect.provide(layer), Effect.orDie)
    })
  }
})
