import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
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
  const states = Machine.state({
    initial: "Count",
    states: {
      Count,
      Done: { schema: Done, type: "final", output: Schema.Number }
    }
  })
  const targets1 = Machine.targets(states)
  return Machine.make({
    root: states,
    events: Machine.eventsFromSchemas(Noop, Increment, Reenter, Finish),
    initialConfiguration: (root) =>
      root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
  }).handle({
    states: {
      Count: {
        on: {
          Noop: { none: true },
          Increment: { target: targets1.root.Count, decoded: ({ state }) => (new Count({ value: state.value + 1 })) },
          Reenter: { none: true, reenter: true, resolve: () => undefined },
          Finish: { target: targets1.root.Done, decoded: ({ state }) => (new Done({ value: state.value })) }
        }
      },
      Done: { output: ({ state }) => state.value }
    }
  })
}

describe("machine planner and runtime strategies", () => {
  for (const strategy of ["generic", "compiled"] as const) {
    it.effect(`keeps independent root lifecycles isolated with the ${strategy} runtime`, () =>
      Effect.gen(function*() {
        const machine = makeFlatMachine()
        const first = yield* openWithRuntimeStrategy(machine, strategy)
        const second = yield* openWithRuntimeStrategy(machine, strategy)
        yield* first.send(new Increment({}))
        yield* first.stop
        yield* second.send(new Increment({}))
        yield* second.send(new Finish({}))
        assert.strictEqual(yield* second.join, 1)
        assert.strictEqual((yield* first.snapshot).status, "stopped")
        const third = yield* openWithRuntimeStrategy(machine, strategy)
        yield* third.send(new Finish({}))
        assert.strictEqual(yield* third.join, 0)
      }))
  }

  it.effect("matches generic and indexed-flat planning including targetless and reentering transitions", () =>
    verifyPlannerStrategies({
      machine: makeFlatMachine(),
      events: [new Noop({}), new Increment({}), new Reenter({}), new Finish({})],
      expected: "indexed-flat",
      label: "flat strategy"
    }))

  it.effect("retains the selected named branch across generic and indexed-flat planning", () => {
    const states = Machine.state({ initial: "Count", states: { Count } })
    const machine = Machine.make({
      branches: { transition1: { negative: { none: true }, zero: { none: true }, positive: { none: true } } },

      root: states,
      events: Machine.eventsFromSchemas(Select),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
    }).handle({
      states: {
        Count: {
          on: {
            Select: {
              branches: "transition1",
              resolve: ({ event, select }) =>
                event.value < 0
                  ? select.negative()
                  : event.value === 0
                  ? select.zero()
                  : select.positive()
            }
          }
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
    const states = Machine.state({ initial: "Count", states: { Count } })
    const targets3 = Machine.targets(states)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets3.root.Count } } },

      root: states,
      events: Machine.eventsFromSchemas(Select),
      initialConfiguration: (root) =>
        root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
    }).handle({
      states: {
        Count: {
          on: {
            Select: {
              branches: "transition1",
              resolve: ({ event, state, select: { destination: target }, decline }) =>
                event.value < 0
                  ? decline()
                  : target.decoded(new Count({ value: state.value + event.value })),
              declinable: true
            }
          }
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

  it.effect("matches generic and indexed-hierarchical state updates", () => {
    class Root extends Schema.TaggedClass<Root>("StrategyUpdateRoot")("Root", { revision: Schema.Number }) {}
    class Work extends Schema.TaggedClass<Work>("StrategyUpdateWork")("Work", {}) {}
    class Left extends Schema.TaggedClass<Left>("StrategyUpdateLeft")("Left", { value: Schema.Number }) {}
    class Right extends Schema.TaggedClass<Right>("StrategyUpdateRight")("Right", { value: Schema.Number }) {}
    class Leaf extends Schema.TaggedClass<Leaf>("StrategyUpdateLeaf")("Leaf", {}) {}
    class Outside extends Schema.TaggedClass<Outside>("StrategyUpdateOutside")("Outside", {}) {}
    class UpdateRegions extends Schema.TaggedClass<UpdateRegions>("StrategyUpdateRegions")("UpdateRegions", {}) {}
    class Compete extends Schema.TaggedClass<Compete>("StrategyUpdateCompete")("Compete", {}) {}
    class ExitRoot extends Schema.TaggedClass<ExitRoot>("StrategyUpdateExitRoot")("ExitRoot", {}) {}
    class ReenterUpdate extends Schema.TaggedClass<ReenterUpdate>("StrategyUpdateReenter")("ReenterUpdate", {}) {}
    const states = Machine.state({
      initial: "Root",
      states: {
        Root: {
          schema: Root,
          initial: "Work",
          states: {
            Work: {
              schema: Work,
              type: "parallel",
              states: {
                Left: {
                  schema: Left,
                  initial: "Leaf",
                  states: { Leaf }
                },
                Right: {
                  schema: Right,
                  initial: "Leaf",
                  states: { Leaf }
                }
              }
            }
          }
        },
        Outside
      }
    })
    const targets4 = Machine.targets(states)
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(UpdateRegions, Compete, ExitRoot, ReenterUpdate),
      initialConfiguration: (root) =>
        root.resolve(({ target }) =>
          target.from((to) =>
            to.Root.decoded(
              new Root({ revision: 0 }),
              (root) =>
                root.Work.decoded(
                  new Work({}),
                  (work) =>
                    work.Left.decoded(new Left({ value: 0 }), (left) => left.Leaf.decoded(new Leaf({})))
                      .Right.decoded(new Right({ value: 0 }), (right) => right.Leaf.decoded(new Leaf({})))
                )
            )
          )
        )
    }).handle({
      states: {
        Root: {
          states: {
            Work: {
              states: {
                Left: {
                  states: {
                    Leaf: {
                      on: {
                        UpdateRegions: {
                          update: targets4.root.Root.Work.Left,
                          decoded: (
                            { ancestors: { "Root.Work.Left": current } }
                          ) => (new Left({ value: current.value + 1 }))
                        },
                        Compete: { update: targets4.root.Root, decoded: () => (new Root({ revision: 1 })) },
                        ExitRoot: { update: targets4.root.Root, decoded: () => (new Root({ revision: 3 })) },
                        ReenterUpdate: {
                          update: targets4.root.Root.Work.Left,
                          reenter: true,
                          decoded: (
                            { ancestors: { "Root.Work.Left": current } }
                          ) => (new Left({ value: current.value + 1 }))
                        }
                      }
                    }
                  }
                },
                Right: {
                  states: {
                    Leaf: {
                      on: {
                        UpdateRegions: {
                          update: targets4.root.Root.Work.Right,
                          decoded: (
                            { ancestors: { "Root.Work.Right": current } }
                          ) => (new Right({ value: current.value + 2 }))
                        },
                        Compete: { update: targets4.root.Root, decoded: () => (new Root({ revision: 2 })) },
                        ExitRoot: { target: targets4.root.Outside, decoded: () => (new Outside({})) }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })

    return Effect.gen(function*() {
      yield* verifyPlannerStrategies({
        machine,
        events: [new UpdateRegions({}), new ReenterUpdate({}), new Compete({}), new ExitRoot({})],
        expected: "indexed-hierarchical",
        label: "state updates"
      })

      const initial = yield* Machine.planInitial(machine)
      const updated = yield* Machine.plan(machine, initial.state, new UpdateRegions({}))
      if (updated.next.state.path !== "Root") throw new Error("expected Root")
      assert.strictEqual(updated.next.state.state.states.Left.value.value, 1)
      assert.strictEqual(updated.next.state.state.states.Right.value.value, 2)

      const reentered = yield* Machine.plan(machine, updated.next, new ReenterUpdate({}))
      assert.deepStrictEqual(reentered.microsteps[0]?.exitPaths, ["Root.Work.Left.Leaf"])
      assert.deepStrictEqual(reentered.microsteps[0]?.entryPaths, ["Root.Work.Left.Leaf"])

      const competed = yield* Machine.plan(machine, reentered.next, new Compete({}))
      if (competed.next.state.path !== "Root") throw new Error("expected Root")
      assert.strictEqual(competed.next.state.value.revision, 1)

      const exited = yield* Machine.plan(machine, competed.next, new ExitRoot({}))
      assert.strictEqual(exited.next.state.path, "Outside")
    })
  })

  it.effect("matches generic and indexed planning for a topology target with a retained owner update", () => {
    class Ready extends Schema.TaggedClass<Ready>("StrategyCombinedReady")("Ready", {
      revision: Schema.Number
    }) {}
    class Idle extends Schema.TaggedClass<Idle>("StrategyCombinedIdle")("Idle", {}) {}
    class Saving extends Schema.TaggedClass<Saving>("StrategyCombinedSaving")("Saving", {
      request: Schema.String
    }) {}
    class Save extends Schema.TaggedClass<Save>("StrategyCombinedSave")("Save", {
      request: Schema.String
    }) {}
    const states = Machine.state({
      initial: "Ready",
      states: {
        Ready: {
          schema: Ready,
          initial: "Idle",
          states: { Idle, Saving }
        }
      }
    })
    const targets5 = Machine.targets(states)
    const machine = Machine.make({
      branches: { transition1: { destination: { target: targets5.root.Ready.Saving, update: targets5.root.Ready } } },

      root: states,
      events: Machine.eventsFromSchemas(Save),
      initialConfiguration: (root) =>
        root.resolve(({ target }) =>
          target.from((to) => to.Ready.decoded(new Ready({ revision: 0 }), (ready) => ready.Idle.decoded(new Idle({}))))
        )
    }).handle({
      states: {
        Ready: {
          states: {
            Idle: {
              on: {
                Save: {
                  branches: "transition1",
                  resolve: ({ ancestors: { "Ready": current }, event, select: { destination: target } }) =>
                    target.decoded(new Saving({ request: event.request })).update.decoded(
                      new Ready({ revision: current.revision + 1 })
                    )
                }
              }
            },
            Saving: {}
          }
        }
      }
    })

    return verifyPlannerStrategies({
      machine,
      events: [new Save({ request: "plan" })],
      expected: "indexed-hierarchical",
      label: "combined retained owner update"
    })
  })

  it.effect("retains indexed execution microstep evidence without widening frozen execution values", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const initial = yield* Machine.planInitial(machine)
      const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan
      const active = Configuration.normalizeConfigurationSync<Machine.Machine.States<typeof machine>>(
        machine,
        initial.state
      )
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
      const states = Machine.state({
        initial: "Root",
        states: {
          Root: {
            schema: Root,
            type: "parallel",
            states: { Left, Right }
          }
        }
      })
      const targets6 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Advance),
        initialConfiguration: (root) =>
          root.resolve(({ target }) =>
            target.from((to) =>
              to.Root.decoded(
                new Root({}),
                (root) => root.Left.decoded(new Left({ value: 0 })).Right.decoded(new Right({ value: 0 }))
              )
            )
          )
      }).handle({
        states: {
          Root: {
            states: {
              Left: {
                on: {
                  Advance: {
                    target: targets6.root.Root.Left,
                    decoded: ({ state }) => (new Left({ value: state.value + 1 }))
                  }
                }
              },
              Right: {
                on: {
                  Advance: {
                    target: targets6.root.Root.Right,
                    decoded: ({ state }) => (new Right({ value: state.value + 10 }))
                  }
                }
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
      const states = Machine.state({
        initial: "Outside",
        states: {
          Outside,
          Opened: {
            schema: Opened,
            initial: "Idle",
            states: { Idle }
          }
        }
      })
      const targets7 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Enter),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Outside.decoded(new Outside({}))))
      }).handle({
        states: {
          Outside: {
            on: {
              Enter: { initial: targets7.root.Opened, decoded: () => (new Opened({})) }
            }
          },
          Opened: {
            initialize: ({ builder }) => builder.from({ value: 1 })
          }
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
      const states = Machine.state({ initial: "Idle", states: { Idle, Ready } })
      const targets8 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
      }).handle({
        states: {
          Idle: {
            always: { target: targets8.root.Ready, decoded: () => (new Ready({})) }
          },
          Ready: {}
        }
      })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
      yield* verifyPlannerStrategies({
        machine,
        events: [],
        expected: "generic",
        label: "automatic fallback"
      })
    }))

  it.effect("compares structural startup with the generic planner", () =>
    Effect.gen(function*() {
      const states = Machine.state({ initial: "Idle", states: { Idle: {} } })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.from()))
      }).handle({ states: { Idle: {} } })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "indexed-flat")
      yield* verifyPlannerStrategies({
        machine,
        events: [],
        expected: "indexed-flat",
        label: "structural startup"
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
      const states = Machine.state({
        initial: "Complete",
        states: {
          Complete: { schema: Complete, type: "final", output: Schema.Number }
        }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        input: Input,
        initialConfiguration: (root) =>
          root.resolve(({ input: input, target }) =>
            target.from((to) => to.Complete.decoded(new Complete({ value: input.value })))
          )
      }).handle({
        states: {
          Complete: { output: ({ state }) => state.value }
        }
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
      const states = Machine.state({
        initial: "Streaming",
        states: {
          Streaming,
          StreamDone: { schema: StreamDone, type: "final", output: Schema.Array(Schema.Number) }
        }
      })
      const seen: Array<number> = []
      const targets9 = Machine.targets(states)
      const definition = Machine.make({
        streams: { source1: Stream.suspend(() => Stream.fromIterable([1, 2, 3])) },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Streaming.from()))
      })
      const machine = definition.handle({
        states: {
          Streaming: {
            invoke: {
              src: "source1",
              id: "values",
              onElement: {
                none: true,
                resolve: ({ element }) => {
                  seen.push(element)
                }
              },
              onDone: { target: targets9.root.StreamDone, decoded: () => (new StreamDone({ values: [...seen] })) }
            }
          },
          StreamDone: { output: ({ state }) => state.values }
        }
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
      const states = Machine.state({ initial: "Count", states: { Count } })
      const targets10 = Machine.targets(states)
      const definition = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Event),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Count.decoded(new Count({ value: 0 }))))
      })
      const events = definition.events
      const machine = definition.handle({
        states: {
          Count: {
            on: {
              Set: { target: targets10.root.Count, decoded: ({ event }) => (new Count({ value: event.value.length })) }
            }
          }
        }
      })

      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const updated = yield* ref.changes.pipe(
          Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.value.value === 2),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(events.Set({ value: "ok" }))
        yield* Fiber.join(updated)
        const snapshot = yield* ref.snapshot
        assert.strictEqual(snapshot.status, "active")
        assert.strictEqual(snapshot.state.state.value.value, 2, `${strategy} decoded the construction`)
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
      const states = Machine.state({ initial: "Idle", states: { Idle } })
      const Events = Machine.eventsFromSchemas(Publish)
      const Emissions = Machine.emittedEventsFromSchemas(Published)
      let value: unknown = 1
      const machine = Machine.make({
        root: states,
        events: Events,
        emittedEvents: Emissions,
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
      }).handle({
        states: {
          Idle: {
            on: {
              Publish: {
                none: true,
                resolve: ({ self }, enqueue) => {
                  assert.ok(self.sessionId.startsWith("machine:"))
                  enqueue.emit(Emissions.Published({ value } as never))
                  return undefined
                }
              }
            }
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
      const states = Machine.state({ initial: "Idle", states: { Idle } })
      const Emissions = Machine.emittedEventsFromSchemas(Ready)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        emittedEvents: Emissions,
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
      }).handle({
        states: {
          Idle: {
            entry: (_, enqueue) => {
              enqueue.emit(Emissions.Ready())
              return undefined
            }
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
            before: step.before.state.value.value,
            after: step.after.state.value.value,
            handled: step.handled,
            configurationChanged: step.configurationChanged,
            done: step.plan.done,
            microsteps: step.plan.microsteps.map((microstep) => ({
              event: microstep.event._tag,
              next: microstep.next.state.value.value,
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
          Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.value.value === 1),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* ref.send(new Increment({}))
        yield* Fiber.join(updated)

        assert.deepStrictEqual(yield* Machine.encodeSnapshot(machine, retained.state), retainedEncoding)
        assert.strictEqual(retained.status, "active")
        assert.strictEqual(retained.state.state.value.value, 0)
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
      const states = Machine.state({
        initial: "Idle",
        states: {
          Idle,
          Loading,
          Success: { schema: Success, type: "final", output: Schema.String }
        }
      })
      const targets12 = Machine.targets(states)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.succeed(new Loaded({ value: "complete" }))) },

        root: states,
        events: Machine.eventsFromSchemas(Load, Loaded),
        initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.Idle.decoded(new Idle({}))))
      }).handle({
        states: {
          Idle: {
            on: {
              Load: { target: targets12.root.Loading, decoded: () => (new Loading({})) }
            }
          },
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onDone: {
                target: targets12.root.Success,
                decoded: ({ output }) => (new Success({ value: output.value }))
              }
            }
          },
          Success: { output: ({ state }) => state.value }
        }
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

  it.effect("matches initial choice invoke and retry lifecycles across managed runtimes", () =>
    Effect.gen(function*() {
      class Flow extends Schema.TaggedClass<Flow>("StrategyChoiceFlow")("StrategyChoiceFlow", {
        authenticated: Schema.Boolean
      }) {}
      class Retry extends Schema.TaggedClass<Retry>("StrategyChoiceRetry")("StrategyChoiceRetry", {}) {}
      const states = Machine.state({
        initial: "Flow",
        states: {
          Flow: {
            schema: Flow,
            initial: "Routing",
            states: {
              Routing: { type: "choice" },
              Checking: {},
              Failed: {},
              Plans: {},
              MemberNavigating: {}
            }
          }
        }
      })
      const waitForPath = (ref: Machine.MachineRef<any, any, any, any>, path: string) =>
        Effect.gen(function*() {
          for (let index = 0; index < 100; index += 1) {
            if ((yield* ref.state).state.state.path === path) return
            yield* Effect.yieldNow
          }
          return assert.fail(`machine did not reach ${path}`)
        })
      const results: Array<unknown> = []

      for (const strategy of ["generic", "compiled"] as const) {
        let membershipAttempts = 0
        let navigationRuns = 0
        const targets13 = Machine.targets(states)
        const machine = Machine.make({
          branches: {
            transition1: {
              authenticated: { target: targets13.root.Flow.Checking },
              anonymous: { target: targets13.root.Flow.Plans }
            }
          },
          effects: {
            source1: Effect.suspend(() =>
              Effect.suspend(() => {
                membershipAttempts += 1
                return membershipAttempts === 1 ? Effect.fail("offline") : Effect.succeed("active")
              })
            ),
            source2: Effect.suspend(() =>
              Effect.sync(() => {
                navigationRuns += 1
              }).pipe(Effect.andThen(Effect.never))
            )
          },

          root: states,
          events: Machine.eventsFromSchemas(Retry),
          input: Schema.Struct({ authenticated: Schema.Boolean }),
          initialConfiguration: (root) =>
            root.resolve(({ input, target }) => target.from((to) => to.Flow.from(input, (flow) => flow.Routing())))
        }).handle({
          states: {
            Flow: {
              states: {
                Routing: {
                  choice: {
                    branches: "transition1",
                    resolve: ({ containingState, select }) =>
                      containingState.authenticated ? select.authenticated.from() : select.anonymous.from()
                  }
                },
                Checking: {
                  invoke: {
                    src: "source1",
                    id: "membership",
                    onDone: { target: targets13.root.Flow.MemberNavigating },
                    onFailure: { target: targets13.root.Flow.Failed }
                  }
                },
                Failed: {
                  on: {
                    StrategyChoiceRetry: { target: targets13.root.Flow.Checking }
                  }
                },
                MemberNavigating: {
                  invoke: { src: "source2", id: "navigate" }
                }
              }
            }
          }
        })

        assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
        const ref = yield* openWithRuntimeStrategy(machine, strategy, { authenticated: true })
        yield* waitForPath(ref, "Flow.Failed")
        yield* ref.send(new Retry({}))
        yield* waitForPath(ref, "Flow.MemberNavigating")
        for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
        results.push({
          membershipAttempts,
          navigationRuns,
          path: (yield* ref.state).state.state.path
        })
        yield* ref.stop
      }

      assert.deepStrictEqual(results, [
        { membershipAttempts: 2, navigationRuns: 1, path: "Flow.MemberNavigating" },
        { membershipAttempts: 2, navigationRuns: 1, path: "Flow.MemberNavigating" }
      ])
    }) as Effect.Effect<void, unknown, any>)

  it.effect("matches generic and indexed invoke failure traces", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("StrategyInvokeFailureLoading")("Loading", {}) {}
      class Failed extends Schema.TaggedClass<Failed>("StrategyInvokeFailureFailed")("Failed", {
        error: Schema.String
      }) {}
      const states = Machine.state({
        initial: "Loading",
        states: {
          Loading,
          Failed: { schema: Failed, type: "final", output: Schema.String }
        }
      })
      const targets14 = Machine.targets(states)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.fail("unavailable")) },

        root: states,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Loading.decoded(new Loading({}))))
      }).handle({
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onFailure: { target: targets14.root.Failed, decoded: ({ error }) => (new Failed({ error })) }
            }
          },
          Failed: { output: ({ state }) => state.error }
        }
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

      const ParentEvents = Machine.eventsFromSchemas(ChildReady)
      const childStates = Machine.state({ initial: "ChildIdle", states: { ChildIdle } })
      const childMachine = Machine.make({
        effects: {
          source1: ({
            parent
          }: Machine.Machine.InvokeContext<
            {
              readonly "":
                & { readonly initial: "ChildIdle"; readonly states: { readonly ChildIdle: typeof ChildIdle } }
                & { readonly "~effect/Machine/ExplicitInitial": true }
            },
            readonly [],
            readonly [],
            "ChildIdle",
            readonly [],
            Machine.Machine.ParentEventSchemas<"required", readonly [typeof ChildReady]>
          >) => parent.send(ParentEvents.ChildReady())
        },

        root: childStates,
        events: Machine.eventsFromSchemas(),
        parent: Machine.parent(ParentEvents),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.ChildIdle.decoded(new ChildIdle({}))))
      }).handle({
        states: {
          ChildIdle: {
            invoke: {
              src: "source1",
              id: "notify-parent",
              input: (context) => context,
              onDone: { none: true },
              onFailure: { none: true }
            }
          }
        }
      })
      const Child = Machine.child("required-parent-child", childMachine)
      const parentStates = Machine.state({
        initial: "ParentWaiting",
        states: {
          ParentWaiting,
          ParentDone: { schema: ParentDone, type: "final", output: Schema.String }
        }
      })
      const targets16 = Machine.targets(parentStates)
      const parentMachine = Machine.make({
        children: { source1: Child },

        root: parentStates,
        events: ParentEvents,
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.ParentWaiting.decoded(new ParentWaiting({}))))
      }).handle({
        states: {
          ParentWaiting: {
            invoke: { src: "source1", onFailure: { none: true } },
            on: {
              ChildReady: { target: targets16.root.ParentDone, decoded: () => (new ParentDone({})) }
            }
          },
          ParentDone: { output: () => "received" }
        }
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
        const states = Machine.state({ initial: "Loading", states: { Loading, Failed } })
        const targets17 = Machine.targets(states)
        const definition = Machine.make({
          logic: {
            worker: (_input: undefined) => {
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
          },
          branches: {
            transition1: {
              stale: { target: targets17.root.Failed, title: "Worker is stale" },
              unchanged: { none: true }
            }
          },

          root: states,
          events: Machine.eventsFromSchemas(Reenter, Stale),
          initialConfiguration: (root) =>
            root.resolve(({ target }) => target.from((to) => to.Loading.decoded(new Loading({ epoch: 0 }))))
        })
        const machine = definition.handle({
          states: {
            Loading: {
              invoke: {
                src: "worker",
                id: "worker",
                address: Machine.childAddress("worker"),
                input: () => undefined,
                onFailure: { none: true },
                onSnapshot: {
                  branches: "transition1",
                  resolve: ({ snapshot, select }) =>
                    snapshot.state === "stale" ? select.stale.decoded(new Failed({})) : select.unchanged()
                }
              },
              on: {
                Reenter: {
                  target: targets17.root.Loading,
                  reenter: true,
                  decoded: ({ state }) => (new Loading({ epoch: state.epoch + 1 }))
                },
                Stale: { target: targets17.root.Failed, decoded: () => (new Failed({})) }
              }
            },
            Failed: {}
          }
        })

        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        yield* Deferred.await(firstStarted)
        const reentered = yield* ref.changes.pipe(
          Stream.filter((snapshot) =>
            snapshot.status === "active" &&
            snapshot.state.state.path === "Loading" &&
            snapshot.state.state.value.epoch === 1
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
        assert.strictEqual(snapshot.state.state.path, "Loading")
        assert.strictEqual(snapshot.state.state.value.epoch, 1)
        assert.strictEqual(generation, 2)
        yield* ref.stop
      }
    }) as Effect.Effect<void, unknown, any>)

  it.effect("keeps dynamically spawned child machines across generic and compiled state changes", () =>
    Effect.gen(function*() {
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("StrategyDynamicChildIdle")("ChildIdle", {}) {}
      const childMachine = Machine.make({
        root: Machine.state({ initial: "ChildIdle", states: { ChildIdle } }),
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.ChildIdle.decoded(new ChildIdle({}))))
      }).handle({ states: { ChildIdle: {} } })
      const Child = Machine.childFamily(childMachine)
      class Commissioning extends Schema.TaggedClass<Commissioning>("StrategyDynamicCommissioning")(
        "Commissioning",
        {}
      ) {}
      class Operating extends Schema.TaggedClass<Operating>("StrategyDynamicOperating")("Operating", {}) {}
      const root18 = Machine.state({ initial: "Commissioning", states: { Commissioning, Operating } })
      const targets18 = Machine.targets(root18)
      const machine = Machine.make({
        effects: {
          source1: ({
            children
          }: Machine.Machine.InvokeContext<
            {
              readonly "": {
                readonly initial: "Commissioning"
                readonly states: { readonly Commissioning: typeof Commissioning; readonly Operating: typeof Operating }
              } & { readonly "~effect/Machine/ExplicitInitial": true }
            },
            readonly [],
            readonly [],
            "Commissioning",
            readonly [],
            readonly []
          >) => children.spawn(Child("runtime"))
        },

        root: root18,
        events: Machine.eventsFromSchemas(),
        initialConfiguration: (root) =>
          root.resolve(({ target }) => target.from((to) => to.Commissioning.decoded(new Commissioning({}))))
      }).handle({
        states: {
          Commissioning: {
            invoke: {
              src: "source1",
              id: "commission",
              input: (context) => context,
              onDone: { target: targets18.root.Operating },
              onFailure: { none: true }
            }
          },
          Operating: {}
        }
      })

      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "indexed-flat")

      const results: Array<unknown> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        yield* ref.changes.pipe(
          Stream.filter((snapshot) => snapshot.status === "active" && snapshot.state.state.path === "Operating"),
          Stream.take(1),
          Stream.runDrain
        )
        const child = yield* ref.child(Child("runtime"))
        assert(Option.isSome(child))
        results.push({
          parent: yield* ref.state,
          child: yield* child.value.state
        })
        yield* ref.stop
        assert.strictEqual((yield* child.value.snapshot).status, "stopped")
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
