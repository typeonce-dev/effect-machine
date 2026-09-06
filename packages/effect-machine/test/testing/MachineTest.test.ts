import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

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

const States = Machine.state({ initial: "Idle", states: { Idle, Ready } })

const makeTraceMachine = (onAction: () => void) =>
  Machine.make({
    root: States,
    events: Machine.eventsFromSchemas(Start, Add),
    input: TestInput,
    initialConfiguration: (root) =>
      root.resolve(({ input, target }) =>
        target.from((to) => to.Ready.decoded(new Ready({ count: input.userId.length - input.userId.length })))
      )
  }).handle({
    states: {
      Idle: {
        on: {
          Start: (to) =>
            to.branch.Ready().resolve(({ target }) => {
              onAction()
              return target.decoded(new Ready({ count: 0 }))
            })
        }
      },
      Ready: {
        on: {
          Add: (to) =>
            to.branch.Ready().resolve(({ event, state, target }) => {
              onAction()
              return target.decoded(new Ready({ count: state.count + event.amount }))
            })
        }
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

  it("preserves opaque-filter diagnostics from schema-derived arbitraries", () => {
    const PositiveInput = Schema.Struct({
      value: Schema.Number.check(
        Schema.makeFilter((value) => value > 0 || "value must be positive", { identifier: "Positive" })
      )
    })
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(),
      input: PositiveInput,
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({ userId: "user-1" }))))
    })

    const generated = MachineTest.scenarios(machine)

    assert.deepStrictEqual(generated.diagnostics.schemas, [{
      boundary: "input",
      index: undefined,
      report: {
        warnings: [{ _tag: "OpaqueFilter", path: ["value"], description: "Positive" }]
      }
    }])
  })

  it("rejects a non-empty minimum for machines without public events", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({ userId: "user-1" }))))
    })

    assert.throws(
      () => MachineTest.scenarios(machine, { minEvents: 1 }),
      /cannot generate a non-empty event sequence for a machine without public events/
    )
  })

  it.effect("runs synchronous startup and event plans", () =>
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

      assert.strictEqual(actionsExecuted, 2)
      assert.deepStrictEqual(trace.initial.startingConfiguration, ["", "Ready"])
      assert.deepStrictEqual(trace.initial.initialEntryPaths, ["", "Ready"])
      assert.deepStrictEqual(trace.initial.startingState.state.value, new Ready({ count: 0 }))
      assert.deepStrictEqual(trace.initial.configuration, ["", "Ready"])
      assert.strictEqual(trace.initial.plan.microsteps.length, 0)
      assert.deepStrictEqual(trace.steps.map((step) => (step.after.state.value as Ready).count), [2, 5])
      assert.deepStrictEqual(trace.finalConfiguration, ["", "Ready"])
      const formatted = MachineTest.formatTrace(trace)
      assert.strictEqual(
        formatted.split("\n")[0],
        "scenario: {\"events\":[{\"_tag\":\"Add\",\"amount\":2},{\"_tag\":\"Add\",\"amount\":3}],\"input\":{\"userId\":\"user-1\"}}"
      )
      assert.match(formatted, /microstep 0: event=/)
      assert.match(formatted, / next=/)
      assert.match(formatted, /final: configuration=\[\(root\), Ready\]/)
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

      const ParallelStates = Machine.state({
        initial: "app",
        states: {
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
        }
      })
      const machine = Machine.make({
        root: ParallelStates,
        events: Machine.eventsFromSchemas(Stop),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) =>
              to.app.decoded(new App({}), (app) =>
                app
                  .left.decoded(new Left({}), (left) => left.idle.decoded(new LeftIdle({})))
                  .right.decoded(new Right({}), (right) => right.idle.decoded(new RightIdle({}))))
            )
          )
      }).handle({
        states: {
          app: {
            states: {
              left: {
                states: {
                  idle: {
                    on: {
                      Stop: (to) => to.branch.disabled().resolve(({ target }) => target.decoded(new Disabled({})))
                    }
                  }
                }
              },
              right: {
                states: {
                  idle: {
                    on: {
                      Stop: (to) => to.branch.disabled().resolve(({ target }) => target.decoded(new Disabled({})))
                    }
                  }
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assert.deepStrictEqual(initial.initialEntryPaths, [
        "",
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
        branchIndex: 0,
        branchKey: undefined,
        target: "disabled",
        resolvedTarget: "disabled",
        updates: []
      }])
    }))

  it.effect("reports both targets as undefined for a targetless transition", () =>
    Effect.gen(function*() {
      const machine = Machine.make({
        root: Machine.state({ initial: "Idle", states: { Idle } }),
        events: Machine.eventsFromSchemas(Start),
        initialConfiguration: (to) =>
          to.resolve(() => ({
            path: "" as const,
            value: undefined,
            state: { path: "Idle" as const, value: new Idle({ userId: "user-1" }) }
          }))
      }).handle({
        states: {
          Idle: {
            on: {
              Start: (to) => to.none
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, new Start({}))

      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.target, undefined)
      assert.strictEqual(planned.microsteps[0]?.transitions[0]?.resolvedTarget, undefined)
    }))
})
