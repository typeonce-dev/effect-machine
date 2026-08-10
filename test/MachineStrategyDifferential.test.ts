import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../src/index.js"
import * as Planner from "../src/internal/machinePlanner.js"
import { MachineTest } from "../src/testing.js"
import type { DifferentialStep } from "./support/machineRuntimeDifferential.js"
import { verifyManagedExecution } from "./support/machineRuntimeDifferential.js"
import { openWithRuntimeStrategy, verifyPlannerStrategies } from "./support/machineStrategyDifferential.js"

class Count extends Schema.TaggedClass<Count>("StrategyCount")("Count", {
  value: Schema.Number
}) {}
class Done extends Schema.TaggedClass<Done>("StrategyDone")("Done", {
  value: Schema.Number
}) {}
class Noop extends Schema.TaggedClass<Noop>("StrategyNoop")("Noop", {}) {}
class Increment extends Schema.TaggedClass<Increment>("StrategyIncrement")("Increment", {}) {}
class Reenter extends Schema.TaggedClass<Reenter>("StrategyReenter")("Reenter", {}) {}
class Finish extends Schema.TaggedClass<Finish>("StrategyFinish")("Finish", {}) {}

const makeFlatMachine = () => {
  const states = Machine.defineStates({
    Count,
    Done: { schema: Done, type: "final", output: Schema.Number }
  })
  return Machine.make({
    states: states.states,
    events: [Noop, Increment, Reenter, Finish],
    initial: () => states.initial.Count(new Count({ value: 0 }))
  }).handle({
    Count: {
      on: {
        Noop: () => undefined,
        Increment: ({ state, target }) => target.full.Count(new Count({ value: state.value + 1 })),
        Reenter: {
          reenter: true,
          transition: ({ state, target }) => target.full.Count(new Count({ value: state.value }))
        },
        Finish: ({ state, target }) => target.full.Done(new Done({ value: state.value }))
      }
    },
    Done: { output: ({ state }) => state.value }
  })
}

describe("machine planner and runtime strategies", () => {
  it.effect("matches generic and indexed-flat planning including targetless and reentering transitions", () =>
    verifyPlannerStrategies({
      machine: makeFlatMachine(),
      events: [new Noop({}), new Increment({}), new Reenter({}), new Finish({})],
      expected: "indexed-flat",
      label: "flat strategy"
    }))

  it.effect("matches generic and indexed-hierarchical planning across simultaneous parallel transitions", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("StrategyRoot")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("StrategyLeft")("Left", { value: Schema.Number }) {}
      class Right extends Schema.TaggedClass<Right>("StrategyRight")("Right", { value: Schema.Number }) {}
      class Advance extends Schema.TaggedClass<Advance>("StrategyAdvance")("Advance", {}) {}
      const states = Machine.defineStates({
        Root: {
          schema: Root,
          type: "parallel",
          states: { Left, Right }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: [Advance],
        initial: () =>
          states.initial.Root(
            new Root({}),
            (root) => root.Left(new Left({ value: 0 })).Right(new Right({ value: 0 }))
          )
      }).handle({
        Root: {
          states: {
            Left: {
              on: {
                Advance: ({ state, target }) => target.branch.Root.Left(new Left({ value: state.value + 1 }))
              }
            },
            Right: {
              on: {
                Advance: ({ state, target }) => target.branch.Root.Right(new Right({ value: state.value + 10 }))
              }
            }
          }
        }
      })

      yield* verifyPlannerStrategies({
        machine,
        events: [new Advance({}), new Advance({})],
        expected: "indexed-hierarchical",
        label: "hierarchical strategy"
      })
    }))

  it.effect("falls back to the generic planner for unsupported automatic transitions", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyFallbackIdle")("Idle", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("StrategyFallbackReady")("Ready", {}) {}
      const states = Machine.defineStates({ Idle, Ready })
      const machine = Machine.make({
        states: states.states,
        events: [],
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: { always: ({ target }) => target.full.Ready(new Ready({})) },
        Ready: {}
      })

      assert.strictEqual(Planner.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
      yield* verifyPlannerStrategies({
        machine,
        events: [],
        expected: "generic",
        label: "automatic fallback"
      })
    }))

  it.effect("matches indexed startup for decoded input and an initially final machine", () =>
    Effect.gen(function*() {
      const Input = Schema.Struct({ value: Schema.Number })
      class Complete extends Schema.TaggedClass<Complete>("StrategyComplete")("Complete", {
        value: Schema.Number
      }) {}
      const states = Machine.defineStates({
        Complete: { schema: Complete, type: "final", output: Schema.Number }
      })
      const machine = Machine.make({
        states: states.states,
        events: [],
        input: Input,
        initial: (input) => states.initial.Complete(new Complete({ value: input.value }))
      }).handle({
        Complete: { output: ({ state }) => state.value }
      })

      yield* verifyPlannerStrategies({
        machine,
        initialArgs: [{ value: 42 }],
        events: [],
        expected: "indexed-flat",
        label: "initially final startup"
      })

      const compiledInitial = Planner.selectExecutionPlanForTesting(machine, "indexed-flat").plan.initial!
      assert.throws(
        () => compiledInitial([{ value: "invalid" }]),
        Machine.MachineSchemaDecodeError
      )
    }))

  it.effect("matches generic and compiled managed runtimes for targetless, reentering, and terminal events", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const initial = yield* Machine.planInitial(machine)
      const events = [new Noop({}), new Increment({}), new Reenter({}), new Finish({})]
      const steps: Array<DifferentialStep> = []
      let state = initial.state
      for (const event of events) {
        const plan = yield* Machine.plan(machine, state, event)
        steps.push({ event, plan })
        state = plan.next
      }

      for (const strategy of ["generic", "compiled"] as const) {
        yield* verifyManagedExecution({
          machine,
          open: openWithRuntimeStrategy(machine, strategy),
          initial: { state: initial.state, done: initial.done, output: initial.output },
          steps,
          label: `${strategy} runtime`
        })
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("does not mutate retained public snapshots in either runtime strategy", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const retained = yield* ref.snapshot
        const retainedEncoding = yield* Machine.encodeSnapshot(machine, retained.state)
        const updated = yield* ref.changes.pipe(
          Stream.drop(1),
          Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.value.value === 1),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(new Increment({}))
        yield* Fiber.join(updated)

        assert.deepStrictEqual(yield* Machine.encodeSnapshot(machine, retained.state), retainedEncoding)
        assert.strictEqual(retained.status, "active")
        assert.strictEqual(retained.state.value.value, 0)
        yield* ref.stop
      }
    }))

  it.effect("matches generic and compiled invoke completion traces", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyInvokeIdle")("Idle", {}) {}
      class Loading extends Schema.TaggedClass<Loading>("StrategyInvokeLoading")("Loading", {}) {}
      class Success extends Schema.TaggedClass<Success>("StrategyInvokeSuccess")("Success", {
        value: Schema.String
      }) {}
      class Load extends Schema.TaggedClass<Load>("StrategyInvokeLoad")("Load", {}) {}
      class Loaded extends Schema.TaggedClass<Loaded>("StrategyInvokeLoaded")("Loaded", {
        value: Schema.String
      }) {}
      const states = Machine.defineStates({
        Idle,
        Loading,
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const machine = Machine.make({
        states: states.states,
        events: [Load, Loaded],
        initial: () => states.initial.Idle(new Idle({}))
      }).handle({
        Idle: {
          on: { Load: () => states.initial.Loading(new Loading({})) }
        },
        Loading: {
          invoke: Machine.invoke({
            id: "load",
            src: () => Machine.effect(Effect.succeed(new Loaded({ value: "complete" })))
          }),
          on: {
            Loaded: ({ event }) => states.initial.Success(new Success({ value: event.value }))
          }
        },
        Success: { output: ({ state }) => state.value }
      })

      const results: Array<unknown> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        yield* ref.send(new Load({}))
        const output = yield* ref.join
        const snapshot = yield* ref.snapshot
        results.push({
          output,
          status: snapshot.status,
          state: yield* Machine.encodeSnapshot(machine, snapshot.state)
        })
      }
      assert.deepStrictEqual(results[1], results[0])
    }) as Effect.Effect<void, unknown, any>)

  it.effect("compares generated eligible models across canonical and indexed planners", () =>
    Effect.gen(function*() {
      const generated = MachineTest.finiteModels({
        maxRoots: 2,
        maxDepth: 3,
        maxChildren: 3,
        maxParallelRegions: 3,
        maxEvents: 3,
        maxTransitions: 10,
        maxHistoryStates: 0,
        maxChoiceStates: 0
      })
      const samples = FastCheck.sample(generated.arbitrary, { numRuns: 120, seed: 81_109 })
      let compared = 0
      for (let index = 0; index < samples.length && compared < 24; index++) {
        const model = samples[index]!
        const machine = MachineTest.compileModel(model)
        const selected = Planner.selectExecutionPlanForTesting(machine, "auto").strategy
        if (selected === "generic") continue
        const events = Array.from({ length: 6 }, (_, eventIndex) => ({
          _tag: model.events[(index + eventIndex) % model.events.length]!
        }))
        yield* verifyPlannerStrategies({
          machine,
          events,
          expected: selected,
          label: `generated strategy ${index}`
        })
        compared += 1
      }
      assert.ok(compared >= 12, `expected at least 12 indexed generated models, compared ${compared}`)
    }), 30_000)
})
