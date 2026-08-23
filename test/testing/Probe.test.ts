import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Counter extends Schema.TaggedClass<Counter>("ProbeCounter")("Counter", {
  count: Schema.Number
}) {}

class Increment extends Schema.TaggedClass<Increment>("ProbeIncrement")("Increment", {
  amount: Schema.Number
}) {}

class Noop extends Schema.TaggedClass<Noop>("ProbeNoop")("Noop", {}) {}
class Ignored extends Schema.TaggedClass<Ignored>("ProbeIgnored")("Ignored", {}) {}
class Decline extends Schema.TaggedClass<Decline>("ProbeDecline")("Decline", {}) {}
class Burst extends Schema.TaggedClass<Burst>("ProbeBurst")("Burst", {}) {}
class Reenter extends Schema.TaggedClass<Reenter>("ProbeReenter")("Reenter", {}) {}
class RaisedIncrement extends Schema.TaggedClass<RaisedIncrement>("ProbeRaisedIncrement")("RaisedIncrement", {}) {}

const states = Machine.states({ Counter })

const machine = Machine.make({
  states: states.states,
  events: Machine.events(Increment, Noop, Ignored, Decline, Burst, Reenter),
  internalEvents: Machine.internalEvents(RaisedIncrement),
  initial: (to) => to.Counter().resolve(({ target }) => target.decoded(new Counter({ count: 0 })))
}).handle({
  Counter: {
    on: {
      Increment: (to) =>
        to.full.Counter().resolve(({ event, state, target }) =>
          target.decoded(new Counter({ count: state.count + event.amount }))
        ),
      Noop: (to) => to.none,
      Decline: (to) => to.none.resolve(({ decline }) => decline(), { declinable: true }),
      Reenter: (to) =>
        to.full.Counter().resolve(({ state, target }) => target.decoded(new Counter({ count: state.count })), {
          reenter: true
        }),
      Burst: (to) =>
        to.full.Counter().resolve(({ state, target }, enqueue) => {
          enqueue.raise(new RaisedIncrement({}))
          return target.decoded(new Counter({ count: state.count + 1 }))
        }),
      RaisedIncrement: (to) =>
        to.full.Counter().resolve(({ state, target }) => target.decoded(new Counter({ count: state.count + 10 })))
    }
  }
})

describe("MachineTest probe", () => {
  it.effect("fails closed when a reference has no acknowledged statechart capability", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      const publicOnlyRef: typeof ref = {
        id: ref.id,
        sessionId: ref.sessionId,
        state: ref.state,
        snapshot: ref.snapshot,
        changes: ref.changes,
        emissions: ref.emissions,
        join: ref.join,
        stop: ref.stop,
        send: ref.send,
        child: ref.child,
        childChanges: ref.childChanges
      }

      const error = yield* Effect.flip(MachineTest.probe(machine, publicOnlyRef))
      assert.instanceOf(error, MachineTest.ProbeUnavailableError)
      yield* ref.stop
    }))

  it.effect("acknowledges ignored, targetless, and changing macrosteps without sampling snapshots", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      const probe = yield* MachineTest.probe(machine, ref)

      const ignored = yield* probe.sendAndAwait(new Ignored({}))
      assert.strictEqual(ignored.handled, false)
      assert.strictEqual(ignored.configurationChanged, false)
      assert.strictEqual(ignored.plan.microsteps.length, 0)
      assert.strictEqual(ignored.before.value.count, 0)
      assert.strictEqual(ignored.after.value.count, 0)

      const declined = yield* probe.sendAndAwait(new Decline({}))
      assert.strictEqual(declined.handled, false)
      assert.strictEqual(declined.configurationChanged, false)
      assert.strictEqual(declined.plan.microsteps.length, 0)

      const targetless = yield* probe.sendAndAwait(new Noop({}))
      assert.strictEqual(targetless.handled, true)
      assert.strictEqual(targetless.configurationChanged, false)
      assert.strictEqual(targetless.plan.microsteps.length, 1)
      assert.strictEqual(targetless.after.value.count, 0)

      const changed = yield* probe.sendAndAwait(new Increment({ amount: 2 }))
      assert.strictEqual(changed.handled, true)
      assert.strictEqual(changed.configurationChanged, false)
      assert.strictEqual(changed.before.value.count, 0)
      assert.strictEqual(changed.after.value.count, 2)

      const reentered = yield* probe.sendAndAwait(new Reenter({}))
      assert.strictEqual(reentered.configurationChanged, true)
      assert.strictEqual(reentered.before.value.count, 2)
      assert.strictEqual(reentered.after.value.count, 2)

      const burst = yield* probe.sendAndAwait(new Burst({}))
      assert.deepStrictEqual(burst.plan.microsteps.map(({ event }) => event._tag), ["Burst", "RaisedIncrement"])
      assert.deepStrictEqual(burst.plan.microsteps.map(({ next }) => next.value.count), [3, 13])
      assert.strictEqual(burst.before.value.count, 2)
      assert.strictEqual(burst.after.value.count, 13)

      yield* probe.sendAndAwait(new Increment({ amount: 5 }))
      assert.deepStrictEqual(burst.plan.microsteps.map(({ next }) => next.value.count), [3, 13])

      yield* ref.stop
    }))

  it.effect("fails acknowledged sends after termination instead of leaving a waiter suspended", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      const probe = yield* MachineTest.probe(machine, ref)
      yield* ref.stop

      const error = yield* Effect.flip(probe.sendAndAwait(new Ignored({})))
      assert.instanceOf(error, Machine.StoppedError)
    }))

  it.effect("does not retract an accepted event when its waiting fiber is interrupted", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      const probe = yield* MachineTest.probe(machine, ref)
      const sending = yield* probe.sendAndAwait(new Increment({ amount: 3 })).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* Fiber.interrupt(sending)
      const fence = yield* probe.sendAndAwait(new Ignored({}))
      assert.strictEqual(fence.before.value.count, 3)
      assert.strictEqual(fence.after.value.count, 3)

      yield* ref.stop
    }))

  it.effect("waits through state-scoped invoke startup without waiting for invoke completion", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("ProbeInvokeIdle")("Idle", {}) {}
      class Loading extends Schema.TaggedClass<Loading>("ProbeInvokeLoading")("Loading", {}) {}
      class Load extends Schema.TaggedClass<Load>("ProbeInvokeLoad")("Load", {}) {}
      const invokeStates = Machine.states({ Idle, Loading })
      let starts = 0
      const invokeMachine = Machine.make({
        states: invokeStates.states,
        events: Machine.events(Load),
        initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle({})))
      }).handle({
        Idle: {
          on: {
            Load: (to) => to.full.Loading().resolve(({ target }) => target.decoded(new Loading({})))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("loader", () => {
              starts += 1
              return Effect.never
            })
        }
      })
      const ref = yield* Machine.start(invokeMachine)
      const probe = yield* MachineTest.probe(invokeMachine, ref)

      const loaded = yield* probe.sendAndAwait(new Load({}))
      assert.strictEqual(loaded.after.path, "Loading")
      assert.strictEqual(starts, 1)

      yield* ref.stop
    }))

  it.effect("reports a processing failure to the exact acknowledged send", () =>
    Effect.gen(function*() {
      const ref = yield* Machine.start(machine)
      const probe = yield* MachineTest.probe(machine, ref)

      const error = yield* Effect.flip(
        probe.sendAndAwait({ _tag: "Increment", amount: "invalid" } as unknown as Increment)
      )
      assert.instanceOf(error, Machine.MachineSchemaDecodeError)

      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "error")
    }))
})
