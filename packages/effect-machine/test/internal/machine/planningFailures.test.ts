import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { Machine } from "../../../src/index.js"
import * as ExecutionPlan from "../../../src/internal/machine/executionPlan.js"
import { startWithRuntimeStrategyForTesting } from "../../../src/internal/machine/process.js"

class Idle extends Schema.TaggedClass<Idle>("PlanningFailureIdle")("Idle", {}) {}
class Busy extends Schema.TaggedClass<Busy>("PlanningFailureBusy")("Busy", {}) {}
class Waiting extends Schema.TaggedClass<Waiting>("PlanningFailureWaiting")("Waiting", {}) {}
class Go extends Schema.TaggedClass<Go>("PlanningFailureGo")("Go", {}) {}
class Loop extends Schema.TaggedClass<Loop>("PlanningFailureLoop")("Loop", {}) {}

const defect = new Error("handler defect")

// Uses only indexed-planner capabilities so the optimized initial and drain
// paths are exercised alongside the generic reference.
const makeDefectMachine = (options: { readonly failInitial: boolean }) => {
  const root = Machine.state({ states: { Idle, Busy } })
  const targets = Machine.targets(root)
  return Machine.make({
    root,
    events: Machine.eventsFromSchemas(Go)
  }).handle({
    initial: {
      target: targets.root.Idle,
      decoded: true,
      data: () => {
        if (options.failInitial) throw defect
        return new Idle()
      }
    },
    states: {
      Idle: {
        on: {
          Go: {
            target: targets.root.Busy,
            decoded: true,
            data: () => {
              throw defect
            }
          }
        }
      },
      Busy: {}
    }
  })
}

// Idle and Busy route to each other through `always`, so planning never
// stabilizes once either is entered.
const makeLoopMachine = (options: { readonly loopInitial: boolean }) => {
  const root = Machine.state({ states: { Waiting, Idle, Busy } })
  const targets = Machine.targets(root)
  const loop = {
    Idle: { always: { target: targets.root.Busy, decoded: true, data: () => new Busy() } },
    Busy: { always: { target: targets.root.Idle, decoded: true, data: () => new Idle() } }
  } as const
  const machine = Machine.make({
    root,
    events: Machine.eventsFromSchemas(Loop)
  })
  return options.loopInitial
    ? machine.handle({
      initial: { target: targets.root.Idle, decoded: true, data: new Idle() },
      states: { Waiting: {}, ...loop }
    })
    : machine.handle({
      initial: { target: targets.root.Waiting, decoded: true, data: new Waiting() },
      states: {
        Waiting: { on: { Loop: { target: targets.root.Idle, decoded: true, data: () => new Idle() } } },
        ...loop
      }
    })
}

describe("planning failure classification", () => {
  it("compiles the defect fixture to an optimized planner", () => {
    assert.notStrictEqual(
      ExecutionPlan.selectExecutionPlanForTesting(makeDefectMachine({ failInitial: false }), "auto").strategy,
      "generic"
    )
  })

  for (const strategy of ["generic", "compiled"] as const) {
    it.effect(`${strategy}: wraps an initializer defect in StartupError`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          startWithRuntimeStrategyForTesting(makeDefectMachine({ failInitial: true }), strategy)
        )
        assert.instanceOf(error, Machine.StartupError)
        assert.strictEqual(Cause.squash(error.cause), defect)
      }))

    it.effect(`${strategy}: reports a transition handler throw as a defect`, () =>
      Effect.gen(function*() {
        const ref = yield* startWithRuntimeStrategyForTesting(makeDefectMachine({ failInitial: false }), strategy)
        yield* ref.send(new Go())
        const exit = yield* Effect.exit(ref.join)
        assert(Exit.isFailure(exit))
        assert(Cause.hasDies(exit.cause))
        assert.strictEqual(Cause.squash(exit.cause), defect)
      }))

    it.effect(`${strategy}: keeps initial non-stabilization typed`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          startWithRuntimeStrategyForTesting(makeLoopMachine({ loopInitial: true }), strategy)
        )
        assert.instanceOf(error, Machine.InfiniteTransitionError)
      }))

    it.effect(`${strategy}: keeps event-time non-stabilization typed`, () =>
      Effect.gen(function*() {
        const ref = yield* startWithRuntimeStrategyForTesting(makeLoopMachine({ loopInitial: false }), strategy)
        yield* ref.send(new Loop())
        const exit = yield* Effect.exit(ref.join)
        assert(Exit.isFailure(exit))
        assert.isFalse(Cause.hasDies(exit.cause))
        assert.instanceOf(Cause.squash(exit.cause), Machine.InfiniteTransitionError)
      }))
  }
})
