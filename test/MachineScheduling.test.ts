import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, References, Schema } from "effect"
import { Machine } from "../src/index.js"

class SchedulingActive extends Schema.TaggedClass<SchedulingActive>("SchedulingActive")(
  "SchedulingActive",
  {}
) {}

class StartBurst extends Schema.TaggedClass<StartBurst>("StartBurst")("StartBurst", {}) {}

class Burst extends Schema.TaggedClass<Burst>("Burst")("Burst", {}) {}

class ChildPing extends Schema.TaggedClass<ChildPing>("ChildPing")("ChildPing", {}) {}

const burstSize = 1_024
const schedulerOperationBudget = 64

const withFrequentSchedulerYields = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(References.MaxOpsBeforeYield, schedulerOperationBudget))

describe("machine scheduling", () => {
  it.effect("lets the Effect scheduler run a concurrent stop during a sustained event burst", () =>
    withFrequentSchedulerYields(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const processed = yield* Ref.make(0)
      const states = Machine.defineStates({ SchedulingActive })
      const machine = Machine.make({
        states: states.states,
        events: [StartBurst, Burst],
        initial: () => states.initial.SchedulingActive(new SchedulingActive({}))
      }).handle({
        SchedulingActive: {
          on: {
            StartBurst: () =>
              Machine.action(
                Deferred.succeed(entered, void 0).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              ),
            Burst: () => Machine.action(Ref.update(processed, (count) => count + 1))
          }
        }
      })
      const ref = yield* Machine.start(machine)

      yield* ref.send(new StartBurst({}))
      yield* Deferred.await(entered)
      yield* Effect.forEach(
        Array.from({ length: burstSize }),
        () => ref.send(new Burst({})),
        { discard: true }
      )
      const stopFiber = yield* Deferred.await(release).pipe(
        Effect.andThen(ref.stop),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(stopFiber)

      assert.isBelow(yield* Ref.get(processed), burstSize)
      assert.strictEqual((yield* ref.snapshot).status, "stopped")
    })))

  it.effect("lets the Effect scheduler run an invoked child during a sustained parent event burst", () =>
    withFrequentSchedulerYields(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const processed = yield* Ref.make(0)
      const childObservedAt = yield* Deferred.make<number>()
      const Child = Machine.childAddress<ChildPing>("scheduler-child")
      const childLogic = Machine.logic<void, ChildPing, never>({
        initial: undefined,
        run: ({ receive }) =>
          receive.pipe(
            Effect.andThen(Ref.get(processed)),
            Effect.flatMap((count) => Deferred.succeed(childObservedAt, count)),
            Effect.andThen(Effect.never)
          )
      })
      const states = Machine.defineStates({ SchedulingActive })
      const machine = Machine.make({
        states: states.states,
        events: [StartBurst, Burst],
        initial: () => states.initial.SchedulingActive(new SchedulingActive({}))
      }).handle({
        SchedulingActive: {
          invoke: Machine.invoke({
            id: "scheduler-child",
            address: Child,
            src: () => childLogic
          }),
          on: {
            StartBurst: () =>
              Machine.action(
                Deferred.succeed(entered, void 0).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Machine.sendTo(Child, new ChildPing({})))
                )
              ),
            Burst: () => Machine.action(Ref.update(processed, (count) => count + 1))
          }
        }
      })
      const ref = yield* Machine.start(machine)

      yield* ref.send(new StartBurst({}))
      yield* Deferred.await(entered)
      yield* Effect.forEach(
        Array.from({ length: burstSize }),
        () => ref.send(new Burst({})),
        { discard: true }
      )
      yield* Deferred.succeed(release, void 0)

      assert.isBelow(yield* Deferred.await(childObservedAt), burstSize)
      yield* ref.stop
    })))
})
