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
const States = Machine.state({
  states: { Idle, Ready }
})
const makeTraceMachine = (onAction: () => void) => {
  const TraceStates = Machine.state({ fields: { input: Schema.toType(TestInput) }, states: { Idle, Ready } })
  const targets1 = Machine.targets(TraceStates)
  return Machine.make({
    branches: {
      transition1: { destination: { target: targets1.root.Ready } },
      transition2: { destination: { target: targets1.root.Ready } }
    },
    root: TraceStates,
    events: Machine.eventsFromSchemas(Start, Add),
    input: TestInput
  }).handle({
    initial: {
      target: Machine.targets(TraceStates).root.Ready,
      decoded: true,
      data: ({ root: { input: input } }) => new Ready({ count: input.userId.length - input.userId.length })
    },
    root: ({ input }) => ({ input }),
    states: {
      Idle: {
        on: {
          Start: {
            branches: "transition1",
            resolve: ({ select: { destination: target } }) => {
              onAction()
              return target({ data: new Ready({ count: 0 }), decoded: true })
            }
          }
        }
      },
      Ready: {
        on: {
          Add: {
            branches: "transition2",
            resolve: ({ event, state, select: { destination: target } }) => {
              onAction()
              return target({ data: new Ready({ count: state.count + event.amount }), decoded: true })
            }
          }
        }
      }
    }
  })
}
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
      input: PositiveInput
    }).handle({
      initial: {
        target: Machine.targets(States).root.Idle,
        decoded: true,
        data: new Idle({ userId: "user-1" })
      },
      states: {
        Idle: {},
        Ready: {}
      }
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
      events: Machine.eventsFromSchemas()
    }).handle({
      initial: {
        target: Machine.targets(States).root.Idle,
        decoded: true,
        data: new Idle({ userId: "user-1" })
      },
      states: {
        Idle: {},
        Ready: {}
      }
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
      class App extends Schema.TaggedClass<App>("App")("App", {}) {
      }
      class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {
      }
      class LeftIdle extends Schema.TaggedClass<LeftIdle>("LeftIdle")("LeftIdle", {}) {
      }
      class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {
      }
      class RightIdle extends Schema.TaggedClass<RightIdle>("RightIdle")("RightIdle", {}) {
      }
      class Disabled extends Schema.TaggedClass<Disabled>("Disabled")("Disabled", {}) {
      }
      class Stop extends Schema.TaggedClass<Stop>("Stop")("Stop", {}) {
      }
      const ParallelStates = Machine.state({
        states: {
          app: {
            schema: App,
            type: "parallel",
            states: {
              left: {
                schema: Left,
                states: { idle: LeftIdle }
              },
              right: {
                schema: Right,
                states: { idle: RightIdle }
              }
            }
          },
          disabled: Disabled
        }
      })
      const targets2 = Machine.targets(ParallelStates)
      const machine = Machine.make({
        root: ParallelStates,
        events: Machine.eventsFromSchemas(Stop)
      }).handle({
        initial: {
          target: Machine.targets(ParallelStates).root.app,
          decoded: true,
          data: new App({})
        },
        states: {
          app: {
            initial: { left: { decoded: true, data: new Left({}) }, right: { decoded: true, data: new Right({}) } },
            states: {
              left: {
                initial: {
                  decoded: true,
                  data: new LeftIdle({}),
                  target: Machine.targets(ParallelStates).root.app.left.idle
                },
                states: {
                  idle: {
                    on: {
                      Stop: { target: targets2.root.disabled, decoded: true, data: () => (new Disabled({})) }
                    }
                  }
                }
              },
              right: {
                initial: {
                  target: Machine.targets(ParallelStates).root.app.right.idle,
                  decoded: true,
                  data: new RightIdle({})
                },
                states: {
                  idle: {
                    on: {
                      Stop: { target: targets2.root.disabled, decoded: true, data: () => (new Disabled({})) }
                    }
                  }
                }
              }
            }
          },
          disabled: {}
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
      const root3 = Machine.state({ states: { Idle } })
      const machine = Machine.make({
        root: root3,
        events: Machine.eventsFromSchemas(Start)
      }).handle({
        initial: {
          target: Machine.targets(root3).root.Idle,
          decoded: true,
          data: new Idle({ userId: "user-1" })
        },
        states: {
          Idle: {
            on: {
              Start: { none: true }
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
