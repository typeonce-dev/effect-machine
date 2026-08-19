import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../../src/index.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as ExecutionPlan from "../../../src/internal/machine/executionPlan.js"
import { MachineTest } from "../../../src/testing/index.js"
import type { DifferentialStep } from "../../machine/support/runtimeDifferential.js"
import { verifyManagedExecution } from "../../machine/support/runtimeDifferential.js"
import {
  openWithRuntimeStrategy,
  prepareWithRuntimeStrategy,
  verifyPlannerStrategies
} from "./support/strategyDifferential.js"

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
class Select extends Schema.TaggedClass<Select>("StrategySelect")("Select", {
  value: Schema.Number
}) {}

const makeFlatMachine = () => {
  const states = Machine.states({
    Count,
    Done: { schema: Done, type: "final", output: Schema.Number }
  })
  return Machine.make({
    states: states.states,
    events: Machine.events(Noop, Increment, Reenter, Finish),
    initial: (to) => to.Count().resolve(({ target }) => target(new Count({ value: 0 })))
  }).handle({
    Count: {
      on: {
        Noop: (to) => to.none,
        Increment: (to) =>
          to.full.Count().resolve(({ state, target }) => target(new Count({ value: state.value + 1 }))),
        Reenter: (to) => to.none.resolve(() => undefined, { reenter: true }),
        Finish: (to) => to.full.Done().resolve(({ state, target }) => target(new Done({ value: state.value })))
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

  it.effect("retains the selected named branch across generic and indexed-flat planning", () => {
    const states = Machine.states({ Count })
    const machine = Machine.make({
      states: states.states,
      events: Machine.events(Select),
      initial: (to) => to.Count().resolve(({ target }) => target(new Count({ value: 0 })))
    }).handle({
      Count: {
        on: {
          Select: (to) =>
            to.branches({
              negative: { target: to.none },
              zero: { target: to.none },
              positive: { target: to.none }
            }).resolve(({ event, select }) =>
              event.value < 0
                ? select.negative()
                : event.value === 0
                ? select.zero()
                : select.positive()
            )
        }
      }
    })
    const events = [new Select({ value: -1 }), new Select({ value: 0 }), new Select({ value: 1 })]

    return Effect.gen(function*() {
      yield* verifyPlannerStrategies({
        machine,
        events,
        expected: "indexed-flat",
        label: "named branch identity"
      })

      const initial = yield* Machine.planInitial(machine)
      for (let branchIndex = 0; branchIndex < events.length; branchIndex++) {
        const planned = yield* Machine.plan(machine, initial.state, events[branchIndex]!)
        assert.strictEqual(planned.microsteps[0]?.transitions[0]?.branchIndex, branchIndex)
      }
    })
  })

  it.effect("fails closed to generic planning for declinable transitions", () => {
    const states = Machine.states({ Count })
    const machine = Machine.make({
      states: states.states,
      events: Machine.events(Select),
      initial: (to) => to.Count().resolve(({ target }) => target(new Count({ value: 0 })))
    }).handle({
      Count: {
        on: {
          Select: (to) =>
            to.full.Count().resolve(({ event, state, target, decline }) =>
              event.value < 0
                ? decline()
                : target(new Count({ value: state.value + event.value })), { declinable: true })
        }
      }
    })

    return verifyPlannerStrategies({
      machine,
      events: [new Select({ value: -1 }), new Select({ value: 2 })],
      expected: "generic",
      label: "declinable transition"
    })
  })

  it.effect("reenters the source when an explicit targetless transition requests reentry", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Reenter({}))

      assert.deepStrictEqual(planned.next, initial.state)
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, ["Count"])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, ["Count"])
    }))

  it.effect("retains indexed execution microstep evidence without widening frozen execution values", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const initial = yield* Machine.planInitial(machine)
      const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan
      const active = Configuration.normalizeConfigurationSync(machine, initial.state)
      const planned = selected.plan(selected.fromConfiguration(active), new Noop({}))
      const step: ExecutionPlan.ExecutionMicrostep = planned.microsteps[0]!

      assert.ok(!("transitions" in step))
      assert.ok(Object.isFrozen(planned.commands))
      assert.ok(Object.isFrozen(planned.emittedEvents))
      assert.ok(Object.isFrozen(step.commands))
      assert.ok(Object.isFrozen(step.raisedEvents))
      assert.ok(Object.isFrozen(step.emittedEvents))
      assert.ok(Object.isFrozen(step.exitPaths))
      assert.ok(Object.isFrozen(step.entryPaths))
    }))

  it.effect("matches generic and indexed-hierarchical planning across simultaneous parallel transitions", () =>
    Effect.gen(function*() {
      class Root extends Schema.TaggedClass<Root>("StrategyRoot")("Root", {}) {}
      class Left extends Schema.TaggedClass<Left>("StrategyLeft")("Left", { value: Schema.Number }) {}
      class Right extends Schema.TaggedClass<Right>("StrategyRight")("Right", { value: Schema.Number }) {}
      class Advance extends Schema.TaggedClass<Advance>("StrategyAdvance")("Advance", {}) {}
      const states = Machine.states({
        Root: {
          schema: Root,
          type: "parallel",
          states: { Left, Right }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Advance),
        initial: (to) =>
          to.Root.initial.resolve(({ target }) =>
            target(
              new Root({}),
              (root) => root.Left(new Left({ value: 0 })).Right(new Right({ value: 0 }))
            )
          )
      }).handle({
        Root: {
          states: {
            Left: {
              on: {
                Advance: (to) =>
                  to.branch.Root.Left().resolve(({ state, target }) => target(new Left({ value: state.value + 1 })))
              }
            },
            Right: {
              on: {
                Advance: (to) =>
                  to.branch.Root.Right().resolve(({ state, target }) => target(new Right({ value: state.value + 10 })))
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

  it.effect("matches generic and indexed-hierarchical planning for declared initial entry", () =>
    Effect.gen(function*() {
      class Outside extends Schema.TaggedClass<Outside>("StrategyInitialOutside")("Outside", {}) {}
      class Opened extends Schema.TaggedClass<Opened>("StrategyInitialOpened")("Opened", {}) {}
      class Idle extends Schema.TaggedClass<Idle>("StrategyInitialIdle")("Idle", { value: Schema.Number }) {}
      class Enter extends Schema.TaggedClass<Enter>("StrategyInitialEnter")("Enter", {}) {}
      const states = Machine.states({
        Outside,
        Opened: {
          schema: Opened,
          initial: "Idle",
          states: { Idle }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Enter),
        initial: (to) => to.Outside().resolve(({ target }) => target(new Outside({})))
      }).handle({
        Outside: {
          on: {
            Enter: (to) => to.full.Opened.initial.resolve(({ target }) => target(new Opened({})))
          }
        },
        Opened: {
          initialize: ({ builder }) => builder.from({ value: 1 })
        }
      })

      yield* verifyPlannerStrategies({
        machine,
        events: [new Enter({})],
        expected: "indexed-hierarchical",
        label: "declared initial entry"
      })
    }))

  it.effect("preserves value-only updates beside control-changing simultaneous transitions", () =>
    Effect.gen(function*() {
      const model: MachineTest.FiniteModel = {
        roots: [{
          _tag: "Parallel",
          key: "workflow",
          value: 0,
          output: "workflow:done",
          states: [
            {
              _tag: "Compound",
              key: "left",
              value: 1,
              initial: "idle",
              states: [
                { _tag: "Atomic", key: "idle", value: 2 },
                { _tag: "Atomic", key: "ready", value: 3 }
              ]
            },
            { _tag: "Atomic", key: "right", value: 4 }
          ]
        }],
        initial: "workflow",
        events: ["Advance"],
        transitions: [
          {
            source: "workflow.left.idle",
            trigger: { type: "event", event: "Advance" },
            target: "workflow.left.ready",
            reenter: false
          },
          {
            source: "workflow.right",
            trigger: { type: "event", event: "Advance" },
            target: "workflow.right",
            targetValue: 9,
            reenter: false
          }
        ]
      }
      const reference = MachineTest.interpretModel(model, ["Advance"])
      assert.strictEqual(reference.steps[0]!.microsteps[0]!.transitions.length, 2)
      assert.strictEqual(reference.steps[0]!.after.values["workflow.right"]!.value, 9)

      yield* verifyPlannerStrategies({
        machine: MachineTest.compileModel(model),
        events: [{ _tag: "Advance" }],
        expected: "indexed-hierarchical",
        label: "mixed simultaneous strategy"
      })
    }))

  it.effect("falls back to the generic planner for unsupported automatic transitions", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyFallbackIdle")("Idle", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("StrategyFallbackReady")("Ready", {}) {}
      const states = Machine.states({ Idle, Ready })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          always: (to) => to.full.Ready().resolve(({ target }) => target(new Ready({})))
        },
        Ready: {}
      })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
      yield* verifyPlannerStrategies({
        machine,
        events: [],
        expected: "generic",
        label: "automatic fallback"
      })
    }))

  it.effect("fails closed to the generic planner for schema-less active states", () =>
    Effect.gen(function*() {
      const states = Machine.states({ Idle: {} })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Idle().resolve(({ target }) => target.from())
      }).handle({ Idle: {} })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
      yield* verifyPlannerStrategies({
        machine,
        events: [],
        expected: "generic",
        label: "schema-less fallback"
      })
    }))

  it("falls back to the generic planner for unknown state semantics", () => {
    const machine = makeFlatMachine()
    const config = machine.handlers.Count as Machine.Machine.AnyStateConfig & Record<PropertyKey, unknown>
    config.futureSemanticCapability = () => undefined

    assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
  })

  it.effect("matches indexed startup for decoded input and an initially final machine", () =>
    Effect.gen(function*() {
      const Input = Schema.Struct({ value: Schema.Number })
      class Complete extends Schema.TaggedClass<Complete>("StrategyComplete")("Complete", {
        value: Schema.Number
      }) {}
      const states = Machine.states({
        Complete: { schema: Complete, type: "final", output: Schema.Number }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        input: Input,
        initial: (to) =>
          to.Complete().resolve(({ input: input, target }) => target(new Complete({ value: input.value })))
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

      const compiledInitial = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan.initial!
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

  it.effect("matches generic and compiled Stream invocation delivery and completion", () =>
    Effect.gen(function*() {
      class Streaming extends Schema.TaggedClass<Streaming>("StrategyStreaming")("Streaming", {}) {}
      class StreamDone extends Schema.TaggedClass<StreamDone>("StrategyStreamDone")("StreamDone", {
        values: Schema.Array(Schema.Number)
      }) {}
      const states = Machine.states({
        Streaming,
        StreamDone: { schema: StreamDone, type: "final", output: Schema.Array(Schema.Number) }
      })
      const seen: Array<number> = []
      const definition = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Streaming().resolve(({ target }) => target.from())
      })
      const machine = definition.handle({
        Streaming: {
          invoke: (from) =>
            from.stream("values", () => Stream.fromIterable([1, 2, 3])).onElement((to) =>
              to.none.resolve(({ element }) => {
                seen.push(element)
              })
            ).onDone((to) =>
              to.full.StreamDone().resolve(({ target }) => target(new StreamDone({ values: [...seen] })))
            )
        },
        StreamDone: { output: ({ state }) => state.values }
      })

      for (const strategy of ["generic", "compiled"] as const) {
        seen.length = 0
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        assert.deepStrictEqual(yield* ref.join, [1, 2, 3])
        assert.deepStrictEqual(seen, [1, 2, 3])
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("decodes deferred event constructions in generic and compiled managed runtimes", () =>
    Effect.gen(function*() {
      const Event = Schema.TaggedUnion({ Set: { value: Schema.NonEmptyString } })
      const states = Machine.states({ Count })
      const definition = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) => to.Count().resolve(({ target }) => target(new Count({ value: 0 })))
      })
      const events = definition.events
      const machine = definition.handle({
        Count: {
          on: {
            Set: (to) =>
              to.full.Count().resolve(({ event, target }) => target(new Count({ value: event.value.length })))
          }
        }
      })

      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const updated = yield* ref.changes.pipe(
          Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.value.value === 2),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(events.Set({ value: "ok" }))
        yield* Fiber.join(updated)
        const snapshot = yield* ref.snapshot
        assert.strictEqual(snapshot.status, "active")
        assert.strictEqual(snapshot.state.value.value, 2, `${strategy} decoded the construction`)
        yield* ref.stop

        const invalidRef = yield* openWithRuntimeStrategy(machine, strategy)
        yield* invalidRef.send(events.Set({ value: "" }))
        const error = yield* Effect.flip(invalidRef.join)
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "event")
        assert.strictEqual(error.event, "Set")
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("publishes and validates emitted events in generic and compiled managed runtimes", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyEmissionIdle")("Idle", {}) {}
      class Publish extends Schema.TaggedClass<Publish>("StrategyEmissionPublish")("Publish", {}) {}
      class Published extends Schema.TaggedClass<Published>("StrategyEmissionPublished")("Published", {
        value: Schema.Number
      }) {}
      const states = Machine.states({ Idle })
      const Events = Machine.events(Publish)
      const Emissions = Machine.emittedEvents(Published)
      let value: unknown = 1
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          on: {
            Publish: (to) =>
              to.none.resolve(({ self }, enqueue) => {
                assert.ok(self.sessionId.startsWith("machine:"))
                enqueue.emit(Emissions.Published({ value } as never))
                return undefined
              })
          }
        }
      })

      for (const strategy of ["generic", "compiled"] as const) {
        value = 1
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const observed = yield* ref.emissions.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(Events.Publish())
        assert.deepStrictEqual(Array.from(yield* Fiber.join(observed)), [new Published({ value: 1 })])
        yield* ref.stop

        value = "invalid"
        const invalid = yield* openWithRuntimeStrategy(machine, strategy)
        yield* invalid.send(Events.Publish())
        const error = yield* Effect.flip(invalid.join)
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "emission")
        assert.strictEqual(error.event, "Published")
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("observes initial emissions from prepared generic and compiled runtimes", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyPreparedIdle")("Idle", {}) {}
      class Ready extends Schema.TaggedClass<Ready>("StrategyPreparedReady")("Ready", {}) {}
      const states = Machine.states({ Idle })
      const Emissions = Machine.emittedEvents(Ready)
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        emittedEvents: Emissions,
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          entry: (_, enqueue) => {
            enqueue.emit(Emissions.Ready())
            return undefined
          }
        }
      })

      for (const strategy of ["generic", "compiled"] as const) {
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const observed = yield* prepared.emissions.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        const ref = yield* prepared.start
        assert.deepStrictEqual(Array.from(yield* Fiber.join(observed)), [new Ready({})])
        yield* ref.stop
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("publishes equivalent live inspection records from generic and compiled runtimes", () =>
    Effect.scoped(Effect.gen(function*() {
      const machine = makeFlatMachine()
      const results: Array<ReadonlyArray<unknown>> = []

      for (const strategy of ["generic", "compiled"] as const) {
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const observed = yield* prepared.inspection.pipe(
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const ref = yield* prepared.start
        for (const event of [new Noop({}), new Increment({}), new Reenter({}), new Finish({})]) {
          yield* ref.send(event)
          yield* Effect.yieldNow
        }
        yield* ref.join
        results.push(Array.from(yield* Fiber.join(observed)))
      }

      assert.deepStrictEqual(results[0], results[1])
    }) as Effect.Effect<void, unknown, any>))

  it.effect("matches acknowledged probe delivery in generic and compiled managed runtimes", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const results: Array<unknown> = []

      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const probe = yield* MachineTest.probe(machine, ref)
        const steps = []
        for (const event of [new Noop({}), new Increment({}), new Reenter({}), new Finish({})]) {
          steps.push(yield* probe.sendAndAwait(event))
        }
        const output = yield* ref.join
        results.push({
          output,
          steps: steps.map((step) => ({
            event: step.event._tag,
            before: step.before.value.value,
            after: step.after.value.value,
            handled: step.handled,
            configurationChanged: step.configurationChanged,
            done: step.plan.done,
            microsteps: step.plan.microsteps.map((microstep) => ({
              event: microstep.event._tag,
              next: microstep.next.value.value,
              changed: microstep.changed,
              exitPaths: microstep.exitPaths,
              entryPaths: microstep.entryPaths
            }))
          }))
        })
      }

      assert.deepStrictEqual(results[1], results[0])
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
      const states = Machine.states({
        Idle,
        Loading,
        Success: { schema: Success, type: "final", output: Schema.String }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Load, Loaded),
        initial: (to) => to.Idle().resolve(({ target }) => target(new Idle({})))
      }).handle({
        Idle: {
          on: {
            Load: (to) => to.full.Loading().resolve(({ target }) => target(new Loading({})))
          }
        },
        Loading: {
          invoke: (from) =>
            from.effect("load", () => Effect.succeed(new Loaded({ value: "complete" }))).onDone((to) =>
              to.full.Success().resolve(({ output, target }) => target(new Success({ value: output.value })))
            )
        },
        Success: { output: ({ state }) => state.value }
      })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "indexed-flat")

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

  it.effect("matches generic and indexed invoke failure traces", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("StrategyInvokeFailureLoading")("Loading", {}) {}
      class Failed extends Schema.TaggedClass<Failed>("StrategyInvokeFailureFailed")("Failed", {
        error: Schema.String
      }) {}
      const states = Machine.states({
        Loading,
        Failed: { schema: Failed, type: "final", output: Schema.String }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({})))
      }).handle({
        Loading: {
          invoke: (from) =>
            from.effect("load", () => Effect.fail("unavailable")).onFailure((to) =>
              to.full.Failed().resolve(({ error, target }) => target(new Failed({ error })))
            )
        },
        Failed: { output: ({ state }) => state.error }
      })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "indexed-flat")

      const results: Array<unknown> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        results.push({
          output: yield* ref.join,
          snapshot: yield* ref.snapshot
        })
      }
      assert.deepStrictEqual(results[1], results[0])
    }) as Effect.Effect<void, unknown, any>)

  it.effect("delivers required parent events in both runtime strategies", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("StrategyRequiredParentChildIdle")("ChildIdle", {}) {}
      class ParentWaiting extends Schema.TaggedClass<ParentWaiting>("StrategyRequiredParentWaiting")(
        "ParentWaiting",
        {}
      ) {}
      class ParentDone extends Schema.TaggedClass<ParentDone>("StrategyRequiredParentDone")("ParentDone", {}) {}
      class ChildReady extends Schema.TaggedClass<ChildReady>("StrategyRequiredParentReady")("ChildReady", {}) {}

      const ParentEvents = Machine.events(ChildReady)
      const childStates = Machine.states({ ChildIdle })
      const childMachine = Machine.make({
        states: childStates.states,
        events: Machine.events(),
        parent: Machine.parent(ParentEvents),
        initial: (to) => to.ChildIdle().resolve(({ target }) => target(new ChildIdle({})))
      }).handle({
        ChildIdle: {
          invoke: (from) =>
            from.effect("notify-parent", ({ parent }) => parent.send(ParentEvents.ChildReady())).onDone((to) => to.none)
              .onFailure((to) => to.none)
        }
      })
      const Child = Machine.child("required-parent-child", childMachine)
      const parentStates = Machine.states({
        ParentWaiting,
        ParentDone: { schema: ParentDone, type: "final", output: Schema.String }
      })
      const parentMachine = Machine.make({
        states: parentStates.states,
        events: ParentEvents,
        initial: (to) => to.ParentWaiting().resolve(({ target }) => target(new ParentWaiting({})))
      }).handle({
        ParentWaiting: {
          invoke: (from) => from.child(Child).onFailure((to) => to.none),
          on: {
            ChildReady: (to) => to.full.ParentDone().resolve(({ target }) => target(new ParentDone({})))
          }
        },
        ParentDone: { output: () => "received" }
      })

      const outputs: Array<string> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(parentMachine, strategy)
        outputs.push(yield* ref.join)
      }
      assert.deepStrictEqual(outputs, ["received", "received"])
    }) as Effect.Effect<void, unknown, any>)

  it.effect("drops stale invoke messages and snapshots after reentry in both runtime strategies", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("StrategyStaleInvokeLoading")("Loading", {
        epoch: Schema.Number
      }) {}
      class Failed extends Schema.TaggedClass<Failed>("StrategyStaleInvokeFailed")("Failed", {}) {}
      class Reenter extends Schema.TaggedClass<Reenter>("StrategyStaleInvokeReenter")("Reenter", {}) {}
      class Stale extends Schema.TaggedClass<Stale>("StrategyStaleInvokeEvent")("Stale", {}) {}

      for (const strategy of ["generic", "compiled"] as const) {
        const firstStarted = yield* Deferred.make<void>()
        let generation = 0
        const states = Machine.states({ Loading, Failed })
        const definition = Machine.make({
          states: states.states,
          events: Machine.events(Reenter, Stale),
          initial: (to) => to.Loading().resolve(({ target }) => target(new Loading({ epoch: 0 })))
        })
        const machine = definition.handle({
          Loading: {
            invoke: (from) =>
              from.logic("worker", {
                address: Machine.childAddress("worker"),
                logic: () => {
                  generation += 1
                  const current = generation
                  return Machine.logic({
                    initial: "active",
                    run: ({ parent, sendTo, setState }) =>
                      parent === undefined ?
                        Effect.die("worker expected an owning machine") :
                        (current === 1 ? Deferred.succeed(firstStarted, undefined) : Effect.void).pipe(
                          Effect.andThen(Effect.never),
                          Effect.onInterrupt(() =>
                            setState("stale").pipe(
                              Effect.andThen(sendTo(parent, new Stale({})))
                            )
                          )
                        )
                  })
                }
              }).onFailure((to) => to.none).onSnapshot((to) =>
                to.branches({
                  stale: { title: "Worker is stale", target: to.full.Failed() },
                  unchanged: { target: to.none }
                }).resolve(({ snapshot, select }) =>
                  snapshot.state === "stale"
                    ? select.stale(new Failed({}))
                    : select.unchanged()
                )
              ),
            on: {
              Reenter: (to) =>
                to.full.Loading().resolve(({ state, target }) => target(new Loading({ epoch: state.epoch + 1 })), {
                  reenter: true
                }),
              Stale: (to) => to.full.Failed().resolve(({ target }) => target(new Failed({})))
            }
          },
          Failed: {}
        })

        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        yield* Deferred.await(firstStarted)
        const reentered = yield* ref.changes.pipe(
          Stream.filter((snapshot) =>
            snapshot.status === "active" &&
            snapshot.state.path === "Loading" &&
            snapshot.state.value.epoch === 1
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(new Reenter({}))
        yield* Fiber.join(reentered)
        yield* Effect.yieldNow

        const snapshot = yield* ref.snapshot
        assert.strictEqual(snapshot.status, "active", `${strategy} accepted a stale invoke callback`)
        assert.strictEqual(snapshot.state.path, "Loading")
        assert.strictEqual(snapshot.state.value.epoch, 1)
        assert.strictEqual(generation, 2)
        yield* ref.stop
      }
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
        const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy
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
