import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../src/index.js"
import { ClusterMachine } from "../../../src/unstable/cluster/index.js"
import { makeLayer, makeMessages, makeTestStorage, startRunner } from "./support/harness.js"

const Events = Machine.events({ Rename: { name: Schema.NonEmptyString }, Archive: {} })
const Internal = Machine.internalEvents({ Touched: {} })

const machine = Machine.make({
  root: Machine.state({
    states: {
      Draft: { fields: { name: Schema.String } },
      Archived: { type: "final" }
    }
  }),
  events: Events,
  internalEvents: Internal
}).handle({
  initial: { target: "Draft", data: { name: "untitled" } },
  states: {
    Draft: {
      on: {
        Rename: { target: "Draft", data: ({ event }) => ({ name: event.name }) },
        Archive: { target: "Archived" },
        Touched: { stay: true }
      }
    }
  }
})

/** The rejection that a send fails with. */
const rejection = <A, E extends { readonly _tag: string }>(send: Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.flip(send), (error) =>
    error._tag === "Rejected"
      ? Effect.succeed(error as Extract<E, { readonly _tag: "Rejected" }>)
      : Effect.die(error))

const start = Effect.gen(function*() {
  const storage = makeTestStorage()
  const runner = yield* startRunner(machine, storage, yield* makeMessages)
  return { storage, runner }
})

describe("ClusterMachine.Client", () => {
  it.effect("takes an event built by a constructor of the protocol, and a plain one", () =>
    Effect.gen(function*() {
      const { runner } = yield* start
      assert.strictEqual(runner.client.entityId, "worker-1")
      yield* runner.client.send(Events.Rename({ name: "report" }))
      assert.include(JSON.stringify(runner.stored()?.snapshot), "\"report\"")
      yield* runner.client.send({ _tag: "Rename", name: "summary" })
      yield* runner.client.send(Events.Archive())
      assert.strictEqual(runner.stored()?.revision, 3)
    }).pipe(Effect.scoped))

  it.effect("rejects an event that its schema refuses before it sends it", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const rejected = yield* rejection(runner.client.send({ _tag: "Rename", name: "" }))
      assert.strictEqual(rejected._tag, "Rejected")
      assert.strictEqual(rejected.reason, "InvalidEvent")
      assert.strictEqual(rejected.message, "The event Rename does not match its schema")
      assert.strictEqual(storage.commitAttempts, 0)
      yield* runner.client.send(Events.Rename({ name: "report" }))
      assert.strictEqual(storage.commits, 1)
    }).pipe(Effect.scoped))

  it.effect("rejects an event that is not an input event", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      const unknownTag = yield* rejection(runner.client.send({ _tag: "Unknown" }))
      assert.strictEqual(unknownTag.reason, "InvalidEvent")
      const internal = yield* rejection(runner.client.send(Internal.Touched() as never))
      assert.strictEqual(internal.reason, "InvalidEvent")
      assert.strictEqual(internal.message, "The event Touched is not an input event")
      assert.strictEqual(storage.commitAttempts, 0)
    }).pipe(Effect.scoped))

  it.effect("fails with the rejection of the machine", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      storage.failNextCommit()
      const rejected = yield* rejection(runner.client.send(Events.Archive()))
      assert.strictEqual(rejected.reason, "PersistenceFailure")
      yield* runner.client.send(Events.Archive())
    }).pipe(Effect.scoped))

  it.effect("starts a machine without input explicitly and treats duplicate starts as no-ops", () =>
    Effect.gen(function*() {
      const { runner, storage } = yield* start
      assert.isTrue(
        Option.isNone(
          yield* runner.client.snapshot.pipe(Effect.provideService(ClusterMachine.Storage, storage.service))
        )
      )
      yield* runner.client.start()
      assert.strictEqual(storage.commits, 1)
      const snap = Option.getOrThrow(
        yield* runner.client.snapshot.pipe(Effect.provideService(ClusterMachine.Storage, storage.service))
      )
      assert.strictEqual(snap.status, "active")
      assert.strictEqual(snap.revision, 1)
      assert.deepStrictEqual<unknown>(snap.state, {
        path: "",
        value: undefined,
        state: { path: "Draft", value: { _tag: "Draft", name: "untitled" } }
      })

      // Duplicate start on an active entity is an idempotent no-op.
      yield* runner.client.start()
      assert.strictEqual(storage.commits, 1)
    }).pipe(Effect.scoped))

  it.effect("starts entities with distinct per-entity input and rejects send before start when no default input is set", () =>
    Effect.gen(function*() {
      class OrderInput extends Schema.Class<OrderInput>("OrderInput")({
        customer: Schema.NonEmptyString,
        total: Schema.Number
      }) {}
      const OrderEvents = Machine.events({ Add: { amount: Schema.Number } })
      const orderMachine = Machine.make({
        id: "OrderWithInput",
        root: Machine.state({
          fields: { customer: Schema.String },
          states: { Open: { fields: { total: Schema.Number } } }
        }),
        input: OrderInput,
        events: OrderEvents
      }).handle({
        root: ({ input }) => ({ customer: input.customer }),
        initial: { target: "Open", data: ({ input }) => ({ total: input.total }) },
        states: {
          Open: {
            on: {
              Add: { update: { Open: ({ event, state }) => ({ total: state.total + event.amount }) } }
            }
          }
        }
      })

      const Order = ClusterMachine.make("OrderWithInput", orderMachine, { version: "1" })
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* Order.client
        const alice = makeClient("order-alice")
        const bob = makeClient("order-bob")

        // Sending before start rejects when no default input was provided to make.
        const beforeStart = yield* rejection(alice.send(OrderEvents.Add({ amount: 5 })))
        assert.strictEqual(beforeStart.reason, "InvalidEvent")
        assert.strictEqual(storage.commitAttempts, 0)

        // Invalid input is rejected locally before hitting storage.
        const badInput = yield* rejection(alice.start({ customer: "", total: 10 }))
        assert.strictEqual(badInput.reason, "InvalidEvent")
        assert.strictEqual(storage.commitAttempts, 0)

        // Start two entities with distinct inputs.
        yield* alice.start(new OrderInput({ customer: "alice", total: 10 }))
        yield* bob.start(new OrderInput({ customer: "bob", total: 50 }))
        yield* alice.send(OrderEvents.Add({ amount: 5 }))

        const aliceSnap = Option.getOrThrow(yield* alice.snapshot)
        const bobSnap = Option.getOrThrow(yield* bob.snapshot)
        assert.deepStrictEqual(aliceSnap.state.value, { _tag: "", customer: "alice" })
        assert.deepStrictEqual(aliceSnap.state.state, { path: "Open", value: { _tag: "Open", total: 15 } })
        assert.deepStrictEqual(bobSnap.state.value, { _tag: "", customer: "bob" })
        assert.deepStrictEqual(bobSnap.state.state, { path: "Open", value: { _tag: "Open", total: 50 } })

        // Calling start again on an active entity is a no-op and preserves its state.
        yield* bob.start(new OrderInput({ customer: "other", total: 999 }))
        const bobAfter = Option.getOrThrow(yield* bob.snapshot)
        assert.deepStrictEqual(bobAfter.state.value, { _tag: "", customer: "bob" })
        assert.strictEqual(bobAfter.revision, 1)
      }).pipe(
        Effect.provide(makeLayer(Order, storage.service)),
        Effect.provideService(ClusterMachine.Storage, storage.service)
      )
    }).pipe(Effect.scoped))

  it.effect("allows start(customInput) to override a static default input and rejects start on a failed entity", () =>
    Effect.gen(function*() {
      const InputEvents = Machine.events({ Bump: {} })
      const machineWithDefault = Machine.make({
        id: "DefaultInputMachine",
        root: Machine.state({
          states: {
            Counting: { fields: { count: Schema.Number } },
            Failing: {}
          }
        }),
        input: Schema.Number,
        events: InputEvents,
        effects: { fail: Effect.die(new Error("boom")) }
      }).handle({
        initial: { target: "Counting", data: ({ input }) => ({ count: input }) },
        states: {
          Counting: {
            on: {
              Bump: {
                target: "Failing"
              }
            }
          },
          Failing: {
            invoke: { src: "fail" }
          }
        }
      })

      const Defaulted = ClusterMachine.make("DefaultInputMachine", machineWithDefault, { version: "1" }, 100)
      const storage = makeTestStorage()
      yield* Effect.gen(function*() {
        yield* TestClock.adjust(1)
        const makeClient = yield* Defaulted.client
        const custom = makeClient("custom-1")
        const auto = makeClient("auto-1")

        // Explicit start uses per-entity input instead of the static default (100).
        yield* custom.start(42)
        const customSnap = Option.getOrThrow(yield* custom.snapshot)
        assert.deepStrictEqual(customSnap.state.state, { path: "Counting", value: { _tag: "Counting", count: 42 } })

        // Auto-start via send uses the static default (100), then enters Failing and fails.
        yield* auto.send(InputEvents.Bump())
        yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true })
        const failedSnap = Option.getOrThrow(yield* auto.snapshot)
        assert.strictEqual(failedSnap.status, "failed")

        // Starting a failed entity rejects with MachineFailed.
        const rejected = yield* rejection(auto.start(7))
        assert.strictEqual(rejected.reason, "MachineFailed")
      }).pipe(
        Effect.provide(makeLayer(Defaulted, storage.service)),
        Effect.provideService(ClusterMachine.Storage, storage.service)
      )
    }).pipe(Effect.scoped))
})
