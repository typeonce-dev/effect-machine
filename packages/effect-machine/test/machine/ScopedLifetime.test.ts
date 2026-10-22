import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Option, Ref, Scope, Stream } from "effect"
import { Machine } from "../../src/index.js"

const Events = Machine.events({ Go: {} })

const makeWatcher = (released: Ref.Ref<boolean>) =>
  Machine.make({
    root: Machine.state({ states: { Watching: {} } }),
    events: Events,
    streams: { watch: Stream.never.pipe(Stream.ensuring(Ref.set(released, true))) }
  }).handle({
    initial: { target: "Watching" },
    states: { Watching: { invoke: { src: "watch", onDone: { none: true } } } }
  })

describe("Machine scoped lifetime", () => {
  it.effect("closing the starting scope stops the machine and releases state-owned work", () =>
    Effect.gen(function*() {
      const released = yield* Ref.make(false)
      const machine = makeWatcher(released)
      const ref = yield* Effect.scoped(Machine.start(machine))
      assert.strictEqual(yield* Ref.get(released), true)
      const snapshot = yield* ref.snapshot
      assert.strictEqual(snapshot.status, "stopped")
      const sent = yield* Effect.flip(ref.send(Events.Go()))
      assert.instanceOf(sent, Machine.StoppedError)
    }))

  it.effect("interrupts effect invocations and stops invoked children", () =>
    Effect.gen(function*() {
      const effectInterrupted = yield* Deferred.make<void>()
      const child = Machine.make({
        root: Machine.state({ states: { Running: {} } }),
        events: Machine.events({})
      }).handle({
        initial: { target: "Running" },
        states: { Running: {} }
      })
      const Child = Machine.child("child", child)
      const parent = Machine.make({
        root: Machine.state({ states: { Active: {} } }),
        events: Machine.events({}),
        effects: { hold: Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(effectInterrupted, void 0))) },
        children: { child: Child }
      }).handle({
        initial: { target: "Active" },
        states: {
          Active: {
            invoke: [
              { src: "hold" },
              { src: "child" }
            ]
          }
        }
      })
      const { childRef, ref } = yield* Effect.scoped(Effect.gen(function*() {
        const ref = yield* Machine.start(parent)
        const childRef = yield* ref.childChanges(Child).pipe(
          Stream.filter(Option.isSome),
          Stream.runHead,
          Effect.map(Option.flatten),
          Effect.map(Option.getOrThrow)
        )
        assert.strictEqual((yield* childRef.snapshot).status, "active")
        return { childRef, ref }
      }))
      yield* Deferred.await(effectInterrupted)
      assert.strictEqual((yield* ref.snapshot).status, "stopped")
      assert.strictEqual((yield* childRef.snapshot).status, "stopped")
    }))

  it.effect("an earlier stop leaves the scope finalizer with nothing to do", () =>
    Effect.gen(function*() {
      const released = yield* Ref.make(false)
      const machine = makeWatcher(released)
      const ref = yield* Effect.scoped(Effect.gen(function*() {
        const ref = yield* Machine.start(machine)
        yield* ref.stop
        assert.strictEqual(yield* Ref.get(released), true)
        return ref
      }))
      assert.strictEqual((yield* ref.snapshot).status, "stopped")
    }))

  it.effect("a completed machine is unaffected by scope closure", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ states: { Done: { type: "final" } } }),
        events: Machine.events({})
      }).handle({ initial: { target: "Done" }, states: { Done: {} } })
      const ref = yield* Effect.scoped(Effect.gen(function*() {
        const ref = yield* Machine.start(machine)
        yield* ref.join
        return ref
      }))
      assert.strictEqual((yield* ref.snapshot).status, "done")
    }))

  it.effect("resume and prepared.start share the scoped lifetime", () =>
    Effect.gen(function*() {
      const resumedReleased = yield* Ref.make(false)
      const resumedMachine = makeWatcher(resumedReleased)
      const initial = yield* Machine.planInitial(resumedMachine)
      const resumed = yield* Effect.scoped(Machine.resume(resumedMachine, initial.state))
      assert.strictEqual(yield* Ref.get(resumedReleased), true)
      assert.strictEqual((yield* resumed.snapshot).status, "stopped")

      const preparedReleased = yield* Ref.make(false)
      const preparedMachine = makeWatcher(preparedReleased)
      const prepared = yield* Machine.prepare(preparedMachine)
      const started = yield* Effect.scoped(prepared.start)
      assert.strictEqual(yield* Ref.get(preparedReleased), true)
      assert.strictEqual((yield* started.snapshot).status, "stopped")
    }))

  it.effect("the scope that first evaluates prepared.start owns the machine", () =>
    Effect.gen(function*() {
      const released = yield* Ref.make(false)
      const prepared = yield* Machine.prepare(makeWatcher(released))
      const owner = yield* Scope.make()
      const ref = yield* prepared.start.pipe(Scope.provide(owner))
      const again = yield* Effect.scoped(prepared.start)
      assert.strictEqual(again, ref)
      assert.strictEqual(yield* Ref.get(released), false)
      yield* Scope.close(owner, Exit.void)
      assert.strictEqual(yield* Ref.get(released), true)
    }))

  it.effect("an explicitly owned scope lets a machine outlive its caller", () =>
    Effect.gen(function*() {
      const released = yield* Ref.make(false)
      const machine = makeWatcher(released)
      const owner = yield* Scope.make()
      const ref = yield* Effect.scoped(Machine.start(machine).pipe(Scope.provide(owner)))
      assert.strictEqual(yield* Ref.get(released), false)
      assert.strictEqual((yield* ref.snapshot).status, "active")
      yield* Scope.close(owner, Exit.void)
      assert.strictEqual(yield* Ref.get(released), true)
    }))
})
