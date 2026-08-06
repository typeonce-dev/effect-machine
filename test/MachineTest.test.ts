import { assert, describe, it } from "@effect/vitest"
import { Data, Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../src/index.js"
import { MachineTest } from "../src/testing.js"

class TestInput extends Schema.Class<TestInput>("TestInput")({
  userId: Schema.String
}) {}

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {
  userId: Schema.String
}) {}

class Ready extends Schema.TaggedClass<Ready>("Ready")("Ready", {
  count: Schema.Int
}) {}

class Start extends Schema.TaggedClass<Start>("Start")("Start", {}) {}

class Add extends Schema.TaggedClass<Add>("Add")("Add", {
  amount: Schema.Int
}) {}

class InitialPlanFailure extends Data.TaggedError("InitialPlanFailure")<{
  readonly reason: string
}> {}

class EventPlanFailure extends Data.TaggedError("EventPlanFailure")<{
  readonly amount: number
}> {}

const States = Machine.defineStates({ Idle, Ready })

const makeTraceMachine = (onAction: () => void) =>
  Machine.make({
    states: States.states,
    events: [Start, Add],
    input: TestInput,
    initial: Effect.fn(function*({ userId }) {
      const runtime = yield* Machine.runtime<{ readonly events: Start | Add }>()
      yield* runtime.raise(new Start({}))
      return States.initial.Idle(new Idle({ userId }))
    })
  }).handle({
    Idle: {
      on: {
        Start: Effect.fn(function*({ target }) {
          yield* Machine.action(Effect.sync(onAction))
          return target.full.Ready(new Ready({ count: 0 }))
        })
      }
    },
    Ready: {
      on: {
        Add: ({ event, state, target }) =>
          Machine.action(
            Effect.sync(onAction),
            target.full.Ready(new Ready({ count: state.count + event.amount }))
          )
      }
    }
  })

describe("MachineTest", () => {
  it("derives complete scenarios from machine schemas and reports diagnostics", () => {
    const machine = makeTraceMachine(() => undefined)
    const generated = MachineTest.scenarios(machine, { minEvents: 2, maxEvents: 2 })
    const samples = FastCheck.sample(generated.arbitrary, 10)

    assert.strictEqual(generated.diagnostics.input, "schema")
    assert.strictEqual(generated.diagnostics.events, "schema")
    assert.strictEqual(generated.diagnostics.schemas.length, 3)
    assert.deepStrictEqual(generated.diagnostics.schemas.map(({ boundary, index }) => ({ boundary, index })), [
      { boundary: "input", index: undefined },
      { boundary: "event", index: 0 },
      { boundary: "event", index: 1 }
    ])
    for (const sample of samples) {
      assert.strictEqual(typeof sample.input.userId, "string")
      assert.strictEqual(sample.events.length, 2)
      for (const event of sample.events) {
        assert.ok(event._tag === "Start" || event._tag === "Add")
      }
    }
  })

  it("accepts whole-input and whole-events arbitrary overrides", () => {
    const machine = makeTraceMachine(() => undefined)
    const input = new TestInput({ userId: "fixed" })
    const events = [new Add({ amount: 2 })] as const
    const generated = MachineTest.scenarios(machine, {
      minEvents: 10,
      maxEvents: 10,
      inputArbitrary: FastCheck.constant(input),
      eventsArbitrary: FastCheck.constant(events)
    })

    assert.deepStrictEqual(FastCheck.sample(generated.arbitrary, 1), [{ input, events }])
    assert.strictEqual(generated.diagnostics.input, "override")
    assert.strictEqual(generated.diagnostics.events, "override")
  })

  it("rejects a non-empty minimum for machines without public events", () => {
    const machine = Machine.make({
      states: States.states,
      events: [],
      initial: () => States.initial.Idle(new Idle({ userId: "user-1" }))
    })

    assert.throws(
      () => MachineTest.scenarios(machine, { minEvents: 1 }),
      /cannot generate a non-empty event sequence for a machine without public events/
    )
  })

  it.effect("runs startup and event plans without executing staged actions", () =>
    Effect.gen(function*() {
      let actionsExecuted = 0
      const machine = makeTraceMachine(() => {
        actionsExecuted += 1
      })
      const scenario: MachineTest.Scenario<typeof machine> = {
        input: new TestInput({ userId: "user-1" }),
        events: [new Add({ amount: 2 }), new Add({ amount: 3 })]
      }

      const trace = yield* MachineTest.run(machine, scenario)

      assert.strictEqual(actionsExecuted, 0)
      assert.deepStrictEqual(trace.initial.startingConfiguration, ["Idle"])
      assert.deepStrictEqual(trace.initial.initialEntryPaths, ["Idle"])
      assert.deepStrictEqual(trace.initial.startingState.value, new Idle({ userId: "user-1" }))
      assert.deepStrictEqual(trace.initial.configuration, ["Ready"])
      assert.strictEqual(trace.initial.plan.microsteps.length, 1)
      assert.deepStrictEqual(trace.initial.plan.microsteps[0]?.transitions, [{
        source: "Idle",
        trigger: { type: "event", event: "Start" },
        reenter: false,
        target: "Ready",
        resolvedTarget: "Ready"
      }])
      assert.deepStrictEqual(trace.steps.map((step) => (step.after.value as Ready).count), [2, 5])
      assert.deepStrictEqual(trace.finalConfiguration, ["Ready"])
      const formatted = MachineTest.formatTrace(trace)
      assert.strictEqual(
        formatted.split("\n")[0],
        "scenario: {\"events\":[{\"_tag\":\"Add\",\"amount\":2},{\"_tag\":\"Add\",\"amount\":3}],\"input\":{\"userId\":\"user-1\"}}"
      )
      assert.match(formatted, /microstep 0: event=/)
      assert.match(formatted, / next=/)
      assert.match(formatted, /final: configuration=\[Ready\]/)
    }))

  it.effect("retains structured startup failures for formatting", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: States.states,
        events: [],
        input: TestInput,
        initial: ({ userId }) =>
          Effect.fail(new InitialPlanFailure({ reason: userId })).pipe(
            Effect.as(States.initial.Idle(new Idle({ userId })))
          )
      })
      const scenario: MachineTest.Scenario<typeof machine> = {
        input: new TestInput({ userId: "startup" }),
        events: []
      }

      const failure = yield* MachineTest.run(machine, scenario).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "initial")
      assert.strictEqual(failure.initial, undefined)
      assert.deepStrictEqual(failure.steps, [])
      assert.deepStrictEqual(failure.cause, new InitialPlanFailure({ reason: "startup" }))
      const formatted = MachineTest.formatTrace(failure)
      assert.notMatch(formatted, /\ninitial:/)
      assert.match(formatted, /failure: phase=initial/)
      assert.match(formatted, /InitialPlanFailure/)
    }))

  it.effect("retains the successful trace prefix when an event plan fails", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: States.states,
        events: [Add],
        initial: () => States.initial.Ready(new Ready({ count: 0 }))
      }).handle({
        Ready: {
          on: {
            Add: ({ event, state, target }) =>
              event.amount < 0
                ? Effect.fail(new EventPlanFailure({ amount: event.amount }))
                : Effect.succeed(target.full.Ready(new Ready({ count: state.count + event.amount })))
          }
        }
      })
      const scenario: MachineTest.Scenario<typeof machine> = {
        events: [new Add({ amount: 2 }), new Add({ amount: -1 })]
      }

      const failure = yield* MachineTest.run(machine, scenario).pipe(Effect.flip)

      assert.strictEqual(failure.phase, "event")
      if (failure.phase === "event") {
        assert.strictEqual(failure.eventIndex, 1)
        assert.deepStrictEqual(failure.event, new Add({ amount: -1 }))
        assert.strictEqual(failure.steps.length, 1)
        assert.deepStrictEqual(failure.steps[0]?.after.value, new Ready({ count: 2 }))
        assert.deepStrictEqual(failure.cause, new EventPlanFailure({ amount: -1 }))
      }
      const formatted = MachineTest.formatTrace(failure)
      assert.match(formatted, /\ninitial:/)
      assert.match(formatted, /\nstep 0:/)
      assert.match(formatted, /failure: phase=event eventIndex=1/)
      assert.match(formatted, /EventPlanFailure/)
      assert.notMatch(formatted, /\nfinal:/)
    }))

  it.effect("retains only transitions that survive parallel conflict resolution", () =>
    Effect.gen(function*() {
      class App extends Schema.TaggedClass<App>("App")("App", {}) {}
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
      class LeftIdle extends Schema.TaggedClass<LeftIdle>("LeftIdle")("LeftIdle", {}) {}
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}
      class RightIdle extends Schema.TaggedClass<RightIdle>("RightIdle")("RightIdle", {}) {}
      class Disabled extends Schema.TaggedClass<Disabled>("Disabled")("Disabled", {}) {}
      class Stop extends Schema.TaggedClass<Stop>("Stop")("Stop", {}) {}

      const ParallelStates = Machine.defineStates({
        app: {
          schema: App,
          type: "parallel",
          states: {
            left: {
              schema: Left,
              initial: "idle",
              states: { idle: LeftIdle }
            },
            right: {
              schema: Right,
              initial: "idle",
              states: { idle: RightIdle }
            }
          }
        },
        disabled: Disabled
      })
      const machine = Machine.make({
        states: ParallelStates.states,
        events: [Stop],
        initial: () =>
          ParallelStates.initial.app(
            new App({}),
            (app) =>
              app
                .left(new Left({}), (left) => left.idle(new LeftIdle({})))
                .right(new Right({}), (right) => right.idle(new RightIdle({})))
          )
      }).handle({
        app: {
          states: {
            left: {
              states: {
                idle: {
                  on: {
                    Stop: ({ target }) => target.full.disabled(new Disabled({}))
                  }
                }
              }
            },
            right: {
              states: {
                idle: {
                  on: {
                    Stop: ({ target }) => target.full.disabled(new Disabled({}))
                  }
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(initial.initialEntryPaths, [
        "app",
        "app.left",
        "app.left.idle",
        "app.right",
        "app.right.idle"
      ])
      const planned = yield* Machine.plan(machine, initial.state, new Stop({}))

      assert.deepStrictEqual(planned.microsteps[0]?.transitions, [{
        source: "app.left.idle",
        trigger: { type: "event", event: "Stop" },
        reenter: false,
        target: "disabled",
        resolvedTarget: "disabled"
      }])
    }))

  it.effect("reports both targets as undefined for a targetless transition", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        states: { Idle },
        events: [Start],
        initial: () => ({ path: "Idle", value: new Idle({ userId: "user-1" }) })
      }).handle({
        Idle: {
          on: {
            Start: () => undefined
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Start({}))

      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.target, undefined)
      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.resolvedTarget, undefined)
    }))
})
