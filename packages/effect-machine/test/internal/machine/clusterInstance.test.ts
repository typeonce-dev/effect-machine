import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Option, Schema, Scope, Stream } from "effect"
import {
  ClusterSchema,
  Entity,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake
} from "effect/cluster"
import { Rpc } from "effect/rpc"
import { TestClock } from "effect/testing"
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
    load: (address) =>
      Effect.suspend(() => {
        counts.loads += 1
        return memory.load(address)
      }),
    loadForRequest: (address, requestId) =>
      Effect.suspend(() => {
        counts.loads += 1
        return memory.loadForRequest(address, requestId)
      }),
    commit: (address, checkpoint) =>
      Effect.suspend(() => {
        counts.commits += 1
        return memory.commit(address, checkpoint)
      })
  })
  const revision = memory.load(address).pipe(
    Effect.map(Option.match({ onNone: () => 0, onSome: ({ revision }) => revision }))
  )
  const make = (
    options: {
      readonly machine?: Machine.Machine.Any
      readonly enqueue?: (event: any) => Effect.Effect<void, unknown>
      readonly keepAlive?: (enabled: boolean) => Effect.Effect<void>
      readonly storage?: Storage["Service"]
      readonly withTransaction?: MessageStorage.MessageStorage["Service"]["withTransaction"]
    } = {}
  ) =>
    ClusterInstance.make({
      machine: options.machine ?? Counter,
      definitionId: "Counter",
      version: "1",
      input: [],
      address,
      storage: options.storage ?? storage,
      messageStorage: MessageStorage.MessageStorage.of({
        ...MessageStorage.noop,
        ...(options.withTransaction && { withTransaction: options.withTransaction })
      }),
      enqueue: options.enqueue ?? (() => Effect.void),
      keepAlive: options.keepAlive ?? (() => Effect.void)
    })
  return { counts, make, memory, revision }
})

class Harness extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("test/Harness") {}

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
        streams: { numbers: Stream.make(1) },
        root: Machine.state({ states: { Count: { fields: { value: Schema.Number } } } }),
        events: Machine.eventsFromSchemas(Increment)
      }).handle({
        initial: { target: "Count", data: { value: 0 } },
        states: { Count: { invoke: { src: "numbers", onElement: { stay: true }, onDone: { stay: true } } } }
      })
      const invoking = yield* harness.make({ machine: Invoking })
      assert.instanceOf(yield* invoking.apply(input(1)), Accepted)
      const rejected = yield* invoking.apply(input(2))
      assert.instanceOf(rejected, Rejected)
      assert.strictEqual(rejected.reason, "UnsupportedProcessLocal")
      assert.strictEqual(harness.counts.commits, 1)
    }))
})

class Go extends Schema.TaggedClass<Go>("Go")("Go", {}) {}
class Back extends Schema.TaggedClass<Back>("Back")("Back", {}) {}

/** A machine that loads once, and the runs of its work, which the test ends. */
const makeLoader = () => {
  const runs: Array<{ readonly result: Deferred.Deferred<string>; stopped: boolean }> = []
  const machine = Machine.make({
    id: "Counter",
    root: Machine.state({ states: { Idle: {}, Loading: {}, Loaded: { fields: { result: Schema.String } } } }),
    events: Machine.eventsFromSchemas(Go, Back),
    effects: {
      load: Effect.suspend(() => {
        const run = { result: Deferred.makeUnsafe<string>(), stopped: false }
        runs.push(run)
        return Effect.onInterrupt(Deferred.await(run.result), () =>
          Effect.sync(() => {
            run.stopped = true
          }))
      })
    }
  }).handle({
    initial: { target: "Idle" },
    states: {
      Idle: { on: { Go: { target: "Loading" } } },
      Loading: {
        invoke: { src: "load", onDone: { target: "Loaded", data: ({ output }) => ({ result: output }) } },
        on: { Go: { stay: true }, Back: { target: "Idle" } }
      },
      Loaded: {}
    }
  })
  return { machine, runs }
}
const go = (requestId: number): ClusterInstance.Input => ({
  requestId: Snowflake.Snowflake(requestId),
  event: new Go({})
})
const back = (requestId: number): ClusterInstance.Input => ({
  requestId: Snowflake.Snowflake(requestId),
  event: new Back({})
})
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

describe("ClusterInstance with work", () => {
  it.effect("starts the work of a step whose caller was interrupted after its commit", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      let acknowledge: Effect.Effect<void> = Effect.void
      const switches: Array<boolean> = []
      const instance = yield* harness.make({
        machine,
        withTransaction: (effect) => Effect.tap(effect, () => acknowledge),
        keepAlive: (enabled) => Effect.sync(() => void switches.push(enabled))
      })
      yield* settle
      acknowledge = Effect.never
      const fiber = yield* Effect.forkChild(instance.apply(go(1)), { startImmediately: true })
      yield* settle
      assert.strictEqual(yield* harness.revision, 1)
      assert.strictEqual(runs.length, 0)
      acknowledge = Effect.void
      yield* Fiber.interrupt(fiber)
      // No other input arrives.
      yield* settle
      assert.strictEqual(runs.length, 1)
      assert.deepStrictEqual(switches, [false, true])
      assert.strictEqual(yield* harness.revision, 1)
    }))

  it.effect("answers a request after the keep-alive of its work is enabled", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const switches: Array<boolean> = []
      let failures = 0
      const instance = yield* harness.make({
        machine,
        keepAlive: (enabled) =>
          Effect.sync(() => {
            switches.push(enabled)
            if (failures-- > 0) throw new Error("message storage unavailable")
          })
      })
      yield* settle
      failures = 2
      const fiber = yield* Effect.forkChild(instance.apply(go(1)), { startImmediately: true })
      yield* settle
      assert.strictEqual(runs.length, 1)
      assert.strictEqual(fiber.pollUnsafe(), undefined)
      yield* TestClock.adjust("10 seconds")
      assert.instanceOf(yield* Fiber.join(fiber), Accepted)
      assert.deepStrictEqual(switches, [false, true, true, true])
      assert.instanceOf(yield* instance.apply(back(2)), Accepted)
      assert.deepStrictEqual(switches, [false, true, true, true, false])
    }))

  it.effect("enables the keep-alive after its caller was interrupted", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const switches: Array<boolean> = []
      let block: Effect.Effect<void> = Effect.void
      const instance = yield* harness.make({
        machine,
        keepAlive: (enabled) =>
          Effect.suspend(() => {
            switches.push(enabled)
            return block
          })
      })
      yield* settle
      block = Effect.never
      const fiber = yield* Effect.forkChild(instance.apply(go(1)), { startImmediately: true })
      yield* settle
      block = Effect.void
      yield* Fiber.interrupt(fiber)
      yield* settle
      assert.deepStrictEqual(switches, [false, true, true])
      assert.strictEqual(runs.length, 1)
      assert.isFalse(runs[0]!.stopped)
    }))

  it.effect("applies nothing that waits for its turn when the instance ends", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const scope = yield* Scope.make()
      let hold: Effect.Effect<void> = Effect.void
      const instance = yield* Scope.provide(
        harness.make({ machine, withTransaction: (effect) => Effect.andThen(hold, effect) }),
        scope
      )
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      hold = Effect.never
      const fiber = yield* Effect.forkChild(instance.apply(go(2)), { startImmediately: true })
      yield* settle
      // The result waits behind the request.
      yield* Deferred.succeed(runs[0]!.result, "document")
      yield* settle
      yield* Scope.close(scope, Exit.void)
      hold = Effect.void
      yield* Fiber.interrupt(fiber)
      yield* settle
      yield* TestClock.adjust("1 minute")
      assert.strictEqual(yield* harness.revision, 1)
      assert.strictEqual(harness.counts.commits, 1)
    }))

  it.effect("retries nothing after the instance ends", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const scope = yield* Scope.make()
      let unavailable = false
      const instance = yield* Scope.provide(
        harness.make({
          machine,
          withTransaction: (effect) => unavailable ? Effect.die(new Error("unavailable")) : effect
        }),
        scope
      )
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      unavailable = true
      yield* Deferred.succeed(runs[0]!.result, "document")
      yield* TestClock.adjust("1 minute")
      yield* Scope.close(scope, Exit.void)
      unavailable = false
      const counts = { ...harness.counts }
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(harness.counts, counts)
      assert.strictEqual(yield* harness.revision, 1)
    }))

  it.effect("leaves a keep-alive behind when it ends while replacing it", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine } = makeLoader()
      const scope = yield* Scope.make()
      const switches: Array<boolean> = []
      let block: Effect.Effect<void> = Effect.void
      const instance = yield* Scope.provide(
        harness.make({
          machine,
          keepAlive: (enabled) =>
            Effect.suspend(() => {
              switches.push(enabled)
              return enabled ? block : Effect.void
            })
        }),
        scope
      )
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      assert.deepStrictEqual(switches, [false, true])
      block = Effect.never
      yield* TestClock.adjust("5 minutes")
      // Released, and not yet replaced.
      assert.deepStrictEqual(switches, [false, true, false, true])
      block = Effect.void
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(switches, [false, true, false, true, true])
    }))

  it.effect("keeps its keep-alive when it ends with work, and replaces none without work", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine } = makeLoader()
      const scope = yield* Scope.make()
      const switches: Array<boolean> = []
      const instance = yield* Scope.provide(
        harness.make({ machine, keepAlive: (enabled) => Effect.sync(() => void switches.push(enabled)) }),
        scope
      )
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      assert.instanceOf(yield* instance.apply(back(2)), Accepted)
      yield* TestClock.adjust("30 minutes")
      assert.deepStrictEqual(switches, [false, true, false])
      assert.instanceOf(yield* instance.apply(go(3)), Accepted)
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(switches, [false, true, false, true])
    }))

  it.effect("counts the life of a keep-alive from when it was enabled", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine } = makeLoader()
      const switches: Array<boolean> = []
      const instance = yield* harness.make({
        machine,
        keepAlive: (enabled) => Effect.sync(() => void switches.push(enabled))
      })
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      yield* TestClock.adjust("3 minutes")
      assert.instanceOf(yield* instance.apply(back(2)), Accepted)
      assert.instanceOf(yield* instance.apply(go(3)), Accepted)
      yield* TestClock.adjust("4 minutes")
      assert.deepStrictEqual(switches, [false, true, false, true])
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(switches, [false, true, false, true, false, true])
    }))

  it.effect("leaves no keep-alive behind when it ends while releasing one", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine } = makeLoader()
      const scope = yield* Scope.make()
      const switches: Array<boolean> = []
      yield* Scope.provide(
        harness.make({
          machine,
          keepAlive: (enabled) =>
            Effect.suspend(() => {
              switches.push(enabled)
              return Effect.never
            })
        }),
        scope
      )
      yield* settle
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(switches, [false])
    }))

  it.effect("lets one of two instances apply a result, and restarts nothing that left", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const left = makeLoader()
      const right = makeLoader()
      const first = yield* harness.make({ machine: left.machine })
      assert.instanceOf(yield* first.apply(go(1)), Accepted)
      // The new owner starts the same work while the previous one still drains.
      yield* harness.make({ machine: right.machine })
      yield* settle
      assert.strictEqual(right.runs.length, 1)
      yield* Deferred.succeed(left.runs[0]!.result, "left")
      yield* settle
      assert.strictEqual(yield* harness.revision, 2)
      yield* Deferred.succeed(right.runs[0]!.result, "right")
      yield* TestClock.adjust("1 minute")
      yield* settle
      assert.strictEqual(yield* harness.revision, 2)
      const stored = Option.getOrThrow(yield* harness.memory.load(address))
      assert.deepStrictEqual(stored.snapshot.active.at(-1), {
        path: "Loaded",
        value: { _tag: "Loaded", result: "left" }
      })
      assert.strictEqual(left.runs.length, 1)
      assert.strictEqual(right.runs.length, 1)
    }))

  it.effect("stops the work of a state it can no longer read", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const instance = yield* harness.make({ machine })
      assert.instanceOf(yield* instance.apply(go(1)), Accepted)
      const stored = Option.getOrThrow(yield* harness.memory.load(address))
      yield* harness.memory.commit(address, {
        ...stored,
        revision: 2,
        version: "2",
        origin: { _tag: "Invocation", path: "Loading", id: "load" }
      })
      const rejected = yield* instance.apply(go(2))
      assert.instanceOf(rejected, Rejected)
      assert.strictEqual(rejected.reason, "VersionMismatch")
      yield* settle
      assert.isTrue(runs[0]!.stopped)
      const loads = harness.counts.loads
      yield* TestClock.adjust("1 minute")
      assert.strictEqual(harness.counts.loads, loads)
      assert.strictEqual(yield* harness.revision, 2)
    }))

  it.effect("rejects a request when storage throws instead of failing", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine } = makeLoader()
      const instance = yield* harness.make({
        machine,
        storage: {
          load: () => Effect.succeedNone,
          loadForRequest: () => {
            throw new Error("not a storage")
          },
          commit: () => {
            throw new Error("not a storage")
          }
        }
      })
      const rejected = yield* instance.apply(go(1))
      assert.instanceOf(rejected, Rejected)
      assert.strictEqual(rejected.reason, "PersistenceFailure")
    }))

  it.effect("retries what an interruption of the infrastructure ended", () =>
    Effect.gen(function*() {
      const harness = yield* makeHarness
      const { machine, runs } = makeLoader()
      const switches: Array<boolean> = []
      let interruptTransaction = true
      let interruptSwitch = false
      const instance = yield* harness.make({
        machine,
        withTransaction: (effect) => interruptTransaction ? Effect.interrupt : effect,
        keepAlive: (enabled) =>
          Effect.suspend(() => {
            switches.push(enabled)
            return interruptSwitch ? Effect.interrupt : Effect.void
          })
      })
      // The wake-up could not load, and tries again.
      yield* settle
      assert.deepStrictEqual(harness.counts, { loads: 0, commits: 0 })
      interruptTransaction = false
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(harness.counts, { loads: 1, commits: 0 })
      assert.deepStrictEqual(switches, [false])

      interruptSwitch = true
      const fiber = yield* Effect.forkChild(instance.apply(go(1)), { startImmediately: true })
      yield* settle
      interruptSwitch = false
      yield* TestClock.adjust("10 seconds")
      assert.instanceOf(yield* Fiber.join(fiber), Accepted)
      assert.deepStrictEqual(switches, [false, true, true])

      // The renewal fails once, and is completed.
      interruptSwitch = true
      yield* TestClock.adjust("5 minutes")
      interruptSwitch = false
      yield* TestClock.adjust("10 seconds")
      assert.deepStrictEqual(switches.slice(-2), [false, true])

      interruptTransaction = true
      yield* Deferred.succeed(runs[0]!.result, "document")
      yield* settle
      assert.strictEqual(yield* harness.revision, 1)
      interruptTransaction = false
      yield* TestClock.adjust("20 seconds")
      assert.strictEqual(yield* harness.revision, 2)
      assert.strictEqual(runs.length, 1)
      assert.strictEqual(switches.at(-1), false)
    }))

  describe("with timers", () => {
    const makeWaiting = () =>
      Machine.make({
        id: "Counter",
        root: Machine.state({ states: { Idle: {}, Waiting: {}, Expired: {} } }),
        events: Machine.eventsFromSchemas(Go, Back),
        timers: { wait: "10 seconds" }
      }).handle({
        initial: { target: "Idle" },
        states: {
          Idle: { on: { Go: { target: "Waiting" } } },
          Waiting: {
            invoke: { src: "wait", onDone: { target: "Expired" } },
            on: { Go: { stay: true }, Back: { target: "Idle" } }
          },
          Expired: {}
        }
      })
    const dueAtOf = (harness: Effect.Success<typeof makeHarness>) =>
      Effect.map(harness.memory.load(address), (stored) => {
        const { status } = Option.getOrThrow(stored)
        const progress = status._tag === "Active" ? status.invocations["Waiting"]?.["wait"] : undefined
        return progress?._tag === "Waiting" ? progress.dueAt : undefined
      })

    it.effect("starts the timer of a step whose caller was interrupted after its commit", () =>
      Effect.gen(function*() {
        const harness = yield* makeHarness
        let acknowledge: Effect.Effect<void> = Effect.void
        const switches: Array<boolean> = []
        const instance = yield* harness.make({
          machine: makeWaiting(),
          withTransaction: (effect) => Effect.tap(effect, () => acknowledge),
          keepAlive: (enabled) => Effect.sync(() => void switches.push(enabled))
        })
        yield* settle
        acknowledge = Effect.never
        const fiber = yield* Effect.forkChild(instance.apply(go(1)), { startImmediately: true })
        yield* settle
        yield* TestClock.adjust("4 seconds")
        acknowledge = Effect.void
        yield* Fiber.interrupt(fiber)
        yield* settle
        assert.deepStrictEqual(switches, [false, true])
        assert.strictEqual(yield* dueAtOf(harness), 10_000)
        yield* TestClock.adjust(5999)
        assert.strictEqual(yield* harness.revision, 1)
        yield* TestClock.adjust(1)
        yield* settle
        assert.strictEqual(yield* harness.revision, 2)
        assert.deepStrictEqual(switches, [false, true, false])
      }))

    it.effect("applies no completion that waits for its turn when the instance ends", () =>
      Effect.gen(function*() {
        const harness = yield* makeHarness
        const scope = yield* Scope.make()
        let hold: Effect.Effect<void> = Effect.void
        const instance = yield* Scope.provide(
          harness.make({ machine: makeWaiting(), withTransaction: (effect) => Effect.andThen(hold, effect) }),
          scope
        )
        assert.instanceOf(yield* instance.apply(go(1)), Accepted)
        hold = Effect.never
        const fiber = yield* Effect.forkChild(instance.apply(go(2)), { startImmediately: true })
        yield* settle
        yield* TestClock.adjust("10 seconds")
        yield* settle
        yield* Scope.close(scope, Exit.void)
        hold = Effect.void
        yield* Fiber.interrupt(fiber)
        yield* settle
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(yield* harness.revision, 1)
        assert.strictEqual(harness.counts.commits, 1)
      }))

    it.effect("lets one of two instances fire a timer that both wait for", () =>
      Effect.gen(function*() {
        const harness = yield* makeHarness
        const first = yield* harness.make({ machine: makeWaiting() })
        assert.instanceOf(yield* first.apply(go(1)), Accepted)
        yield* TestClock.adjust("3 seconds")
        // The new owner waits for the same instant while the previous one still drains.
        yield* harness.make({ machine: makeWaiting() })
        yield* TestClock.adjust(6999)
        assert.strictEqual(yield* harness.revision, 1)
        yield* TestClock.adjust(1)
        yield* settle
        assert.strictEqual(yield* harness.revision, 2)
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(yield* harness.revision, 2)
        assert.strictEqual(yield* dueAtOf(harness), undefined)
      }))

    it.effect("stops a wait whose state it can no longer read", () =>
      Effect.gen(function*() {
        const harness = yield* makeHarness
        const instance = yield* harness.make({ machine: makeWaiting() })
        assert.instanceOf(yield* instance.apply(go(1)), Accepted)
        const stored = Option.getOrThrow(yield* harness.memory.load(address))
        yield* harness.memory.commit(address, { ...stored, revision: 2, version: "2", origin: { _tag: "Timers" } })
        const rejected = yield* instance.apply(go(2))
        assert.instanceOf(rejected, Rejected)
        assert.strictEqual(rejected.reason, "VersionMismatch")
        yield* settle
        const commits = harness.counts.commits
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(harness.counts.commits, commits)
        assert.strictEqual(yield* harness.revision, 2)
      }))
  })

  it.effect("stops its work and starts it again when a defect restarts its handlers", () => {
    const { machine, runs } = makeLoader()
    const send = Rpc.make("send", { success: Schema.String }).annotate(ClusterSchema.Persisted, true)
    const crash = Rpc.make("crash")
    let crashes = 0
    const entity = Entity.make("Counter", [send, crash])
    const layer = Effect.gen(function*() {
      const harness = yield* makeHarness
      return Layer.provideMerge(
        entity.toLayer(Effect.gen(function*() {
          const context = yield* Effect.context<Sharding.Sharding | Entity.CurrentAddress>()
          const instance = yield* harness.make({
            machine,
            keepAlive: (enabled) => Effect.provideContext(Entity.keepAlive(enabled), context)
          })
          return entity.of({
            send: ({ requestId }) => Effect.map(instance.apply({ requestId, event: new Go({}) }), ({ _tag }) => _tag),
            // Replayed to the new handlers.
            crash: () => Effect.suspend(() => crashes++ === 0 ? Effect.die(new Error("crash")) : Effect.void)
          })
        })),
        Layer.succeed(Harness, harness)
      )
    }).pipe(
      Layer.unwrap,
      Layer.provideMerge(Sharding.layer),
      Layer.provide(Runners.layerNoop),
      Layer.provideMerge(MessageStorage.layerMemory),
      Layer.provide(RunnerStorage.layerMemory),
      Layer.provide(RunnerHealth.layerNoop),
      Layer.provide(ShardingConfig.layer({
        entityTerminationTimeout: 0,
        entityMessagePollInterval: 5000,
        refreshAssignmentsInterval: 0
      }))
    )
    return Effect.gen(function*() {
      yield* TestClock.adjust(1)
      const harness = yield* Harness
      const driver = yield* MessageStorage.MemoryDriver
      const client = (yield* entity.client)("counter-1")
      assert.strictEqual(yield* client.send(), "Accepted")
      assert.strictEqual(runs.length, 1)
      const crashing = yield* Effect.forkChild(Effect.exit(client.crash()), { startImmediately: true })
      yield* settle
      // Cluster closes the old handlers when it builds the new ones.
      yield* TestClock.adjust("1 second")
      yield* settle
      assert.deepStrictEqual(runs.map(({ stopped }) => stopped), [true, false])
      assert.strictEqual(yield* harness.revision, 1)
      assert.strictEqual(harness.counts.commits, 1)
      assert.strictEqual(driver.unprocessed.size, 1)
      yield* Deferred.succeed(runs[1]!.result, "document")
      yield* settle
      assert.strictEqual(yield* harness.revision, 2)
      assert.strictEqual(driver.unprocessed.size, 0)
      yield* Fiber.join(crashing)
      assert.strictEqual(crashes, 2)
    }).pipe(Effect.provide(layer))
  })
})
