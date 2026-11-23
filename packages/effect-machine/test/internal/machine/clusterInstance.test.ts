import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Latch, Option, Schema } from "effect"
import { MessageStorage, Snowflake } from "effect/cluster"
import { Machine } from "../../../src/index.js"
import * as Cluster from "../../../src/internal/machine/cluster.js"
import * as ClusterInstance from "../../../src/internal/machine/clusterInstance.js"
import { Accepted, Rejected, Storage } from "../../../src/internal/machine/clusterProtocol.js"

class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {}) {}
class Explode extends Schema.TaggedClass<Explode>("Explode")("Explode", {}) {}
class Changed extends Schema.TaggedClass<Changed>("Changed")("Changed", { value: Schema.Number }) {}

const Counter = Machine.make({
  id: "Counter",
  root: Machine.state({ states: { Count: { fields: { value: Schema.Number } } } }),
  events: Machine.eventsFromSchemas(Increment, Explode),
  emittedEvents: Machine.emittedEventsFromSchemas(Changed)
}).handle({
  initial: { target: "Count", data: { value: 0 } },
  states: {
    Count: {
      on: {
        Explode: {
          target: "Count",
          data: () => {
            throw new Error("exploded")
          }
        },
        Increment: {
          branches: [{ target: "Count" }],
          resolve: ({ select, state }, enqueue) => {
            enqueue.emit(new Changed({ value: state.value + 1 }))
            return select.target("Count", { data: { value: state.value + 1 } })
          }
        }
      }
    }
  }
})

const address = {
  entityType: "Counter",
  entityId: "counter-1",
  shardId: { group: "default", id: 1 }
} as any

const input = (requestId: number): ClusterInstance.Input => ({
  requestId: Snowflake.Snowflake(requestId),
  event: new Increment({})
})

/** In-memory storage that counts its calls and can hold its transactions open. */
const makeHarness = Effect.gen(function*() {
  const memory = yield* Cluster.makeMemory
  const counts = { loads: 0, commits: 0 }
  const storage = Storage.of({
    load: (address, requestId) =>
      Effect.suspend(() => {
        counts.loads += 1
        return memory.load(address, requestId)
      }),
    commit: (address, checkpoint) =>
      Effect.suspend(() => {
        counts.commits += 1
        return memory.commit(address, checkpoint)
      })
  })
  const revision = memory.load(address, Snowflake.Snowflake(999)).pipe(
    Effect.map(({ checkpoint }) => Option.match(checkpoint, { onNone: () => 0, onSome: ({ revision }) => revision }))
  )
  const make = (
    options: {
      readonly machine?: Machine.Machine.Any
      readonly enqueue?: (event: any) => Effect.Effect<void, unknown>
      readonly withTransaction?: MessageStorage.MessageStorage["Service"]["withTransaction"]
    } = {}
  ) =>
    ClusterInstance.make({
      machine: options.machine ?? Counter,
      machineId: "Counter",
      version: "1",
      input: [],
      address,
      storage,
      messageStorage: MessageStorage.MessageStorage.of({
        ...MessageStorage.noop,
        ...(options.withTransaction && { withTransaction: options.withTransaction })
      }),
      enqueue: options.enqueue ?? (() => Effect.void)
    })
  return { counts, make, memory, revision }
})

describe("ClusterInstance", () => {
  it.effect("applies concurrent inputs one at a time", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const gate = yield* Latch.make()
      const emitted: Array<unknown> = []
      let inFlight = 0
      let maxInFlight = 0
      const instance = yield* harness.make({
        enqueue: (event) =>
          Effect.suspend(() => {
            emitted.push(event)
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            return Effect.ensuring(
              gate.await,
              Effect.sync(() => {
                inFlight -= 1
              })
            )
          })
      })
      const fibers = yield* Effect.forEach([1, 2, 3], (requestId) =>
        Effect.forkChild(instance.apply(input(requestId)), { startImmediately: true }))
      yield* Effect.yieldNow
      assert.strictEqual(inFlight, 1)
      assert.strictEqual(harness.counts.commits, 1)
      yield* gate.open
      for (const fiber of fibers) {
        assert.instanceOf(yield* Fiber.join(fiber), Accepted)
      }
      assert.strictEqual(maxInFlight, 1)
      assert.deepStrictEqual(
        emitted,
        [1, 2, 3].map((value) =>
          new Changed({ value })
        )
      )
      assert.deepStrictEqual(harness.counts, { loads: 1, commits: 3 })
      assert.strictEqual(yield* harness.revision, 3)
    }))

  it.effect("forgets memory when an input is interrupted after its commit", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      let block = false
      const instance = yield* harness.make({ enqueue: () => block ? Effect.never : Effect.void })
      assert.instanceOf(yield* instance.apply(input(1)), Accepted)
      block = true
      const fiber = yield* Effect.forkChild(instance.apply(input(2)), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.hasInterrupts(exit))
      block = false
      assert.strictEqual(yield* harness.revision, 2)
      assert.instanceOf(yield* instance.apply(input(3)), Accepted)
      assert.deepStrictEqual(harness.counts, { loads: 2, commits: 3 })
      assert.strictEqual(yield* harness.revision, 3)
    }))

  it.effect("forgets memory when an input is interrupted before its commit", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      let block = false
      const instance = yield* harness.make({
        withTransaction: (effect) => block ? Effect.andThen(Effect.never, effect) : effect
      })
      assert.instanceOf(yield* instance.apply(input(1)), Accepted)
      block = true
      const fiber = yield* Effect.forkChild(instance.apply(input(2)), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      block = false
      assert.instanceOf(yield* instance.apply(input(3)), Accepted)
      assert.deepStrictEqual(harness.counts, { loads: 2, commits: 2 })
      assert.strictEqual(yield* harness.revision, 2)
    }))

  it.effect("forgets memory when an input is interrupted while its transaction commits", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      let block = false
      const instance = yield* harness.make({
        withTransaction: (effect) => Effect.tap(effect, () => block ? Effect.never : Effect.void)
      })
      assert.instanceOf(yield* instance.apply(input(1)), Accepted)
      block = true
      const fiber = yield* Effect.forkChild(instance.apply(input(2)), { startImmediately: true })
      yield* Effect.yieldNow
      assert.strictEqual(harness.counts.commits, 2)
      yield* Fiber.interrupt(fiber)
      block = false
      assert.instanceOf(yield* instance.apply(input(3)), Accepted)
      assert.deepStrictEqual(harness.counts, { loads: 2, commits: 3 })
      assert.strictEqual(yield* harness.revision, 3)
    }))

  it.effect("forgets memory when the rollback of a rejected input fails", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      let failRollback = false
      const instance = yield* harness.make({
        withTransaction: (effect) =>
          Effect.catchCause(effect, (cause) =>
            Effect.failCause(failRollback ? Cause.combine(cause, Cause.die("rollback failed")) : cause))
      })
      const explode = (requestId: number) =>
        instance.apply({ ...input(requestId), event: new Explode({}) })
      assert.instanceOf(yield* instance.apply(input(1)), Accepted)
      for (const rollbackFails of [false, true]) {
        failRollback = rollbackFails
        const loads = harness.counts.loads
        const rejected = yield* explode(rollbackFails ? 3 : 2)
        assert.instanceOf(rejected, Rejected)
        assert.strictEqual(rejected.reason, "TransitionFailure")
        assert.instanceOf(yield* instance.apply(input(rollbackFails ? 5 : 4)), Accepted)
        // Asked before the rejection, and loaded again only without a rollback.
        assert.strictEqual(harness.counts.loads, loads + (rollbackFails ? 2 : 1))
      }
      assert.strictEqual(yield* harness.revision, 3)
    }))

  it.effect("keeps memory when an input is interrupted while it waits", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const gate = yield* Latch.make()
      const instance = yield* harness.make({ enqueue: () => gate.await })
      const first = yield* Effect.forkChild(instance.apply(input(1)), { startImmediately: true })
      const second = yield* Effect.forkChild(instance.apply(input(2)), { startImmediately: true })
      yield* Effect.yieldNow
      yield* Fiber.interrupt(second)
      yield* gate.open
      assert.instanceOf(yield* Fiber.join(first), Accepted)
      assert.instanceOf(yield* instance.apply(input(3)), Accepted)
      assert.deepStrictEqual(harness.counts, { loads: 1, commits: 2 })
    }))

  it.effect("serves two instances of one entity without losing an update", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const emitted: Array<unknown> = []
      const enqueue = (event: unknown) =>
        Effect.sync(() => {
          emitted.push(event)
        })
      const left = yield* harness.make({ enqueue })
      const right = yield* harness.make({ enqueue })
      for (let requestId = 1; requestId <= 6; requestId += 2) {
        assert.instanceOf(yield* left.apply(input(requestId)), Accepted)
        assert.instanceOf(yield* right.apply(input(requestId + 1)), Accepted)
      }
      // The same request reaches both instances during a handover.
      assert.instanceOf(yield* left.apply(input(6)), Accepted)
      assert.deepStrictEqual(emitted, [1, 2, 3, 4, 5, 6].map((value) => new Changed({ value })))
      assert.strictEqual(yield* harness.revision, 6)
    }))

  it.effect("recognizes a redelivery to a machine that can no longer run", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const counter = yield* harness.make()
      assert.instanceOf(yield* counter.apply(input(1)), Accepted)
      const Invoking = Machine.make({
        id: "Counter",
        effects: { work: Effect.suspend(() => Effect.void) },
        root: Machine.state({ states: { Count: { fields: { value: Schema.Number } } } }),
        events: Machine.eventsFromSchemas(Increment)
      }).handle({
        initial: { target: "Count", data: { value: 0 } },
        states: { Count: { invoke: { src: "work", id: "work", onDone: { stay: true } } } }
      })
      const invoking = yield* harness.make({ machine: Invoking })
      assert.instanceOf(yield* invoking.apply(input(1)), Accepted)
      const rejected = yield* invoking.apply(input(2))
      assert.instanceOf(rejected, Rejected)
      assert.strictEqual(rejected.reason, "UnsupportedProcessLocal")
      assert.strictEqual(harness.counts.commits, 1)
    }))
})
