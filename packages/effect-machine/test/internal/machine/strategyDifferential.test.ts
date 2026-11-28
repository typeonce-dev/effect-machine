import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import * as Arbitrary from "effect/Arbitrary"
import { Machine } from "../../../src/index.js"
import * as Configuration from "../../../src/internal/machine/configuration.js"
import * as ExecutionPlan from "../../../src/internal/machine/executionPlan.js"
import * as InvocationEvent from "../../../src/internal/machine/invocationEvent.js"
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
    states: {
      Count,
      Done: { schema: Done, type: "final", output: Schema.Number }
    }
  })
  return Machine.make({
    root: states,
    events: Machine.eventsFromSchemas(Noop, Increment, Reenter, Finish)
  }).handle({
    initial: {
      target: "Count",
      decoded: true,
      data: new Count({ value: 0 })
    },
    states: {
      Count: {
        on: {
          Noop: { stay: true },
          Increment: {
            target: "Count",
            decoded: true,
            data: ({ state }) => (new Count({ value: state.value + 1 }))
          },
          Reenter: { reenter: true, commands: () => undefined },
          Finish: { target: "Done", decoded: true, data: ({ state }) => (new Done({ value: state.value })) }
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
    const states = Machine.state({ states: { Count } })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Select)
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: new Count({ value: 0 })
      },
      states: {
        Count: {
          on: {
            Select: {
              branches: [{ stay: true }, { update: "Count" }, { target: "Count" }],
              resolve: ({ event, select }) =>
                event.value < 0
                  ? select.stay()
                  : event.value === 0
                  ? select.update({ Count: { decoded: true, data: new Count({ value: 0 }) } })
                  : select.target("Count", { decoded: true, data: new Count({ value: 1 }) })
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
  it.effect("matches strategies for commands on target, update, stay, and reenter transitions", () => {
    const Emits = Machine.emittedEvents({ Noted: {} })
    const events = Machine.events({ Go: {}, Set: { value: Schema.Number }, Keep: {}, Again: {}, Raised: {} })
    const machine = Machine.make({
      root: Machine.state({ states: { Count } }),
      events,
      emittedEvents: Emits
    }).handle({
      initial: { target: "Count", decoded: true, data: new Count({ value: 0 }) },
      states: {
        Count: {
          on: {
            Go: {
              target: "Count",
              decoded: true,
              data: ({ state }) => new Count({ value: state.value + 1 }),
              commands: (_, enqueue) => enqueue.emit(Emits.Noted())
            },
            Set: {
              update: { Count: { decoded: true, data: ({ event }) => new Count({ value: event.value }) } },
              commands: (_, enqueue) => enqueue.raise(events.Raised())
            },
            Keep: { stay: true, commands: (_, enqueue) => enqueue.emit(Emits.Noted()) },
            Again: { reenter: true, commands: (_, enqueue) => enqueue.raise(events.Raised()) },
            Raised: { stay: true }
          }
        }
      }
    })
    return verifyPlannerStrategies({
      machine,
      events: [
        events.Go(),
        events.Set({ value: 7 }),
        events.Keep(),
        events.Again(),
        events.Go()
      ],
      expected: "indexed-flat",
      label: "transition commands"
    })
  })
  it.effect("fails closed to generic planning when a parallel region's stay preempts its ancestor", () => {
    const events = Machine.events({ Close: { handled: Schema.Boolean } })
    const machine = Machine.make({
      root: Machine.state({
        states: {
          Regions: {
            type: "parallel",
            states: { Left: { states: { A: {} } }, Right: { states: { B: {} } } }
          },
          Closed: {}
        }
      }),
      events
    }).handle({
      initial: { target: "Regions" },
      states: {
        Regions: {
          on: { Close: { target: "Closed" } },
          states: {
            Left: {
              initial: { target: "Regions.Left.A" },
              states: {
                A: {
                  on: {
                    Close: {
                      branches: [{ stay: true }, { decline: true }],
                      resolve: ({ event, select }) => event.handled ? select.stay() : select.decline()
                    }
                  }
                }
              }
            },
            Right: { initial: { target: "Regions.Right.B" }, states: { B: {} } }
          }
        }
      }
    })
    return verifyPlannerStrategies({
      machine,
      events: [events.Close({ handled: true }), events.Close({ handled: false })],
      expected: "generic",
      label: "parallel stay preemption"
    })
  })
  it.effect("fails closed to generic planning for declinable transitions", () => {
    const states = Machine.state({ states: { Count } })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Select)
    }).handle({
      initial: {
        target: "Count",
        decoded: true,
        data: new Count({ value: 0 })
      },
      states: {
        Count: {
          on: {
            Select: {
              branches: [{ target: "Count" }, { decline: true }],
              resolve: ({ event, state, select }) =>
                event.value < 0
                  ? select.decline()
                  : select.target("Count", { data: new Count({ value: state.value + event.value }), decoded: true })
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
    class Root extends Schema.TaggedClass<Root>("StrategyUpdateRoot")("Root", { revision: Schema.Number }) {
    }
    class Work extends Schema.TaggedClass<Work>("StrategyUpdateWork")("Work", {}) {
    }
    class Left extends Schema.TaggedClass<Left>("StrategyUpdateLeft")("Left", { value: Schema.Number }) {
    }
    class Right extends Schema.TaggedClass<Right>("StrategyUpdateRight")("Right", { value: Schema.Number }) {
    }
    class Leaf extends Schema.TaggedClass<Leaf>("StrategyUpdateLeaf")("Leaf", {}) {
    }
    class Outside extends Schema.TaggedClass<Outside>("StrategyUpdateOutside")("Outside", {}) {
    }
    class UpdateRegions extends Schema.TaggedClass<UpdateRegions>("StrategyUpdateRegions")("UpdateRegions", {}) {
    }
    class Compete extends Schema.TaggedClass<Compete>("StrategyUpdateCompete")("Compete", {}) {
    }
    class ExitRoot extends Schema.TaggedClass<ExitRoot>("StrategyUpdateExitRoot")("ExitRoot", {}) {
    }
    class ReenterUpdate extends Schema.TaggedClass<ReenterUpdate>("StrategyUpdateReenter")("ReenterUpdate", {}) {
    }
    const states = Machine.state({
      states: {
        Root: {
          schema: Root,
          states: {
            Work: {
              schema: Work,
              type: "parallel",
              states: {
                Left: {
                  schema: Left,
                  states: { Leaf }
                },
                Right: {
                  schema: Right,
                  states: { Leaf }
                }
              }
            }
          }
        },
        Outside
      }
    })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(UpdateRegions, Compete, ExitRoot, ReenterUpdate)
    }).handle({
      initial: {
        target: "Root",
        decoded: true,
        data: new Root({ revision: 0 })
      },
      states: {
        Root: {
          initial: {
            target: "Root.Work",
            decoded: true,
            data: new Work({})
          },
          states: {
            Work: {
              initial: {
                Left: { decoded: true, data: new Left({ value: 0 }) },
                Right: { decoded: true, data: new Right({ value: 0 }) }
              },
              states: {
                Left: {
                  initial: {
                    decoded: true,
                    data: new Leaf({}),
                    target: "Root.Work.Left.Leaf"
                  },
                  states: {
                    Leaf: {
                      on: {
                        UpdateRegions: {
                          update: {
                            "Root.Work.Left": {
                              decoded: true,
                              data: (
                                { ancestors: { "Root.Work.Left": current } }
                              ) => (new Left({ value: current.value + 1 }))
                            }
                          }
                        },
                        Compete: {
                          update: { Root: { decoded: true, data: () => (new Root({ revision: 1 })) } }
                        },
                        ExitRoot: {
                          update: { Root: { decoded: true, data: () => (new Root({ revision: 3 })) } }
                        },
                        ReenterUpdate: {
                          update: {
                            "Root.Work.Left": {
                              decoded: true,
                              data: (
                                { ancestors: { "Root.Work.Left": current } }
                              ) => (new Left({ value: current.value + 1 }))
                            }
                          },
                          reenter: true
                        }
                      }
                    }
                  }
                },
                Right: {
                  initial: {
                    target: "Root.Work.Right.Leaf",
                    decoded: true,
                    data: new Leaf({})
                  },
                  states: {
                    Leaf: {
                      on: {
                        UpdateRegions: {
                          update: {
                            "Root.Work.Right": {
                              decoded: true,
                              data: (
                                { ancestors: { "Root.Work.Right": current } }
                              ) => (new Right({ value: current.value + 2 }))
                            }
                          }
                        },
                        Compete: {
                          update: { Root: { decoded: true, data: () => (new Root({ revision: 2 })) } }
                        },
                        ExitRoot: { target: "Outside", decoded: true, data: () => (new Outside({})) }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        Outside: {}
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
      if (updated.next.state.path !== "Root") {
        throw new Error("expected Root")
      }
      assert.strictEqual(updated.next.state.state.states.Left.value.value, 1)
      assert.strictEqual(updated.next.state.state.states.Right.value.value, 2)
      const reentered = yield* Machine.plan(machine, updated.next, new ReenterUpdate({}))
      assert.deepStrictEqual(reentered.microsteps[0]?.exitPaths, ["Root.Work.Left.Leaf"])
      assert.deepStrictEqual(reentered.microsteps[0]?.entryPaths, ["Root.Work.Left.Leaf"])
      const competed = yield* Machine.plan(machine, reentered.next, new Compete({}))
      if (competed.next.state.path !== "Root") {
        throw new Error("expected Root")
      }
      assert.strictEqual(competed.next.state.value.revision, 1)
      const exited = yield* Machine.plan(machine, competed.next, new ExitRoot({}))
      assert.strictEqual(exited.next.state.path, "Outside")
    })
  })
  it.effect("matches generic and indexed planning for a topology target with a retained owner update", () => {
    class Ready extends Schema.TaggedClass<Ready>("StrategyCombinedReady")("Ready", {
      revision: Schema.Number
    }) {
    }
    class Idle extends Schema.TaggedClass<Idle>("StrategyCombinedIdle")("Idle", {}) {
    }
    class Saving extends Schema.TaggedClass<Saving>("StrategyCombinedSaving")("Saving", {
      request: Schema.String
    }) {
    }
    class Save extends Schema.TaggedClass<Save>("StrategyCombinedSave")("Save", {
      request: Schema.String
    }) {
    }
    const states = Machine.state({
      states: {
        Ready: {
          schema: Ready,
          states: { Idle, Saving }
        }
      }
    })
    const machine = Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Save)
    }).handle({
      initial: {
        target: "Ready",
        decoded: true,
        data: new Ready({ revision: 0 })
      },
      states: {
        Ready: {
          initial: {
            target: "Ready.Idle",
            decoded: true,
            data: new Idle({})
          },
          states: {
            Idle: {
              on: {
                Save: {
                  branches: [{ target: "Ready.Saving", update: "Ready" }],
                  resolve: ({ ancestors: { Ready: current }, event, select }) =>
                    select.target("Ready.Saving", {
                      data: new Saving({ request: event.request }),
                      decoded: true,
                      update: { Ready: { decoded: true, data: new Ready({ revision: current.revision + 1 }) } }
                    })
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
      const active = Configuration.normalizeConfigurationSync(
        machine,
        initial.state
      )
      const planned = selected.plan(selected.fromConfiguration(active), new Noop({}), "Owned", false)
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
      class Root extends Schema.TaggedClass<Root>("StrategyRoot")("Root", {}) {
      }
      class Left extends Schema.TaggedClass<Left>("StrategyLeft")("Left", { value: Schema.Number }) {
      }
      class Right extends Schema.TaggedClass<Right>("StrategyRight")("Right", { value: Schema.Number }) {
      }
      class Advance extends Schema.TaggedClass<Advance>("StrategyAdvance")("Advance", {}) {
      }
      const states = Machine.state({
        states: {
          Root: {
            schema: Root,
            type: "parallel",
            states: { Left, Right }
          }
        }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Advance)
      }).handle({
        initial: {
          target: "Root",
          decoded: true,
          data: new Root({})
        },
        states: {
          Root: {
            initial: {
              Left: { decoded: true, data: new Left({ value: 0 }) },
              Right: { decoded: true, data: new Right({ value: 0 }) }
            },
            states: {
              Left: {
                on: {
                  Advance: {
                    target: "Root.Left",
                    decoded: true,
                    data: ({ state }) => (new Left({ value: state.value + 1 }))
                  }
                }
              },
              Right: {
                on: {
                  Advance: {
                    target: "Root.Right",
                    decoded: true,
                    data: ({ state }) => (new Right({ value: state.value + 10 }))
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
      class Outside extends Schema.TaggedClass<Outside>("StrategyInitialOutside")("Outside", {}) {
      }
      class Opened extends Schema.TaggedClass<Opened>("StrategyInitialOpened")("Opened", {}) {
      }
      class Idle extends Schema.TaggedClass<Idle>("StrategyInitialIdle")("Idle", { value: Schema.Number }) {
      }
      class Enter extends Schema.TaggedClass<Enter>("StrategyInitialEnter")("Enter", {}) {
      }
      const states = Machine.state({
        states: {
          Outside,
          Opened: {
            schema: Opened,
            states: { Idle }
          }
        }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Enter)
      }).handle({
        initial: {
          target: "Outside",
          decoded: true,
          data: new Outside({})
        },
        states: {
          Outside: {
            on: {
              Enter: { target: "Opened", decoded: true, data: () => (new Opened({})) }
            }
          },
          Opened: {
            initial: {
              target: "Opened.Idle",
              data: () => ({ value: 1 })
            },
            states: {
              Idle: {}
            }
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
      class Idle extends Schema.TaggedClass<Idle>("StrategyFallbackIdle")("Idle", {}) {
      }
      class Ready extends Schema.TaggedClass<Ready>("StrategyFallbackReady")("Ready", {}) {
      }
      const states = Machine.state({ states: { Idle, Ready } })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Idle",
          decoded: true,
          data: new Idle({})
        },
        states: {
          Idle: {
            always: { target: "Ready", decoded: true, data: () => (new Ready({})) }
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
      const states = Machine.state({ states: { Idle: {} } })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Idle"
        },
        states: {
          Idle: {}
        }
      })
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
    const config = machine.handlers.Count as Record<PropertyKey, unknown>
    config.futureSemanticCapability = () => undefined
    assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
  })
  it.effect("matches indexed startup for decoded input and an initially final machine", () =>
    Effect.gen(function*() {
      const Input = Schema.Struct({ value: Schema.Number })
      class Complete extends Schema.TaggedClass<Complete>("StrategyComplete")("Complete", {
        value: Schema.Number
      }) {
      }
      const states = Machine.state({
        fields: {
          input: Schema.toType(Input)
        },
        states: {
          Complete: { schema: Complete, type: "final", output: Schema.Number }
        }
      })
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        input: Input
      }).handle({
        initial: {
          target: "Complete",
          decoded: true,
          data: ({ root: { input } }) => new Complete({ value: input.value })
        },
        root: ({ input }) => ({ input }),
        states: {
          Complete: { output: ({ state }) => state.value }
        }
      })
      yield* verifyPlannerStrategies({
        machine,
        initialArgs: [{ value: 42 }],
        events: [],
        expected: "indexed-hierarchical",
        label: "initially final startup"
      })
      const compiledInitial = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-hierarchical").plan.initial!
      assert.throws(() => compiledInitial([{ value: "invalid" }]), Machine.MachineSchemaDecodeError)
    }))
  it.effect("decodes deferred event constructions in generic and compiled managed runtimes", () =>
    Effect.gen(function*() {
      const Event = Schema.TaggedUnion({ Set: { value: Schema.NonEmptyString } })
      const states = Machine.state({ states: { Count } })
      const definition = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Event)
      })
      const events = definition.events
      const machine = definition.handle({
        initial: {
          target: "Count",
          decoded: true,
          data: new Count({ value: 0 })
        },
        states: {
          Count: {
            on: {
              Set: {
                target: "Count",
                decoded: true,
                data: ({ event }) => (new Count({ value: event.value.length }))
              }
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
        const error = yield* Effect.flip(invalidRef.send(events.Set({ value: "" })))
        assert.instanceOf(error, Machine.MachineSchemaDecodeError)
        assert.strictEqual(error.boundary, "event")
        assert.strictEqual(error.event, "Set")
        const kept = yield* invalidRef.snapshot
        assert.strictEqual(kept.status, "active", `${strategy} kept the machine`)
        assert.strictEqual(kept.state.state.value.value, 0)
        yield* invalidRef.stop
      }
    }) as Effect.Effect<void, unknown, any>)
  it.effect("publishes and validates emitted events in generic and compiled managed runtimes", () =>
    Effect.gen(function*() {
      class Idle extends Schema.TaggedClass<Idle>("StrategyEmissionIdle")("Idle", {}) {
      }
      class Publish extends Schema.TaggedClass<Publish>("StrategyEmissionPublish")("Publish", {}) {
      }
      class Published extends Schema.TaggedClass<Published>("StrategyEmissionPublished")("Published", {
        value: Schema.Number
      }) {
      }
      const states = Machine.state({ states: { Idle } })
      const Events = Machine.eventsFromSchemas(Publish)
      const Emissions = Machine.emittedEventsFromSchemas(Published)
      let value: unknown = 1
      const machine = Machine.make({
        root: states,
        events: Events,
        emittedEvents: Emissions
      }).handle({
        initial: {
          target: "Idle",
          decoded: true,
          data: new Idle({})
        },
        states: {
          Idle: {
            on: {
              Publish: {
                stay: true,
                commands: ({ self }, enqueue) => {
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
      class Idle extends Schema.TaggedClass<Idle>("StrategyPreparedIdle")("Idle", {}) {
      }
      class Ready extends Schema.TaggedClass<Ready>("StrategyPreparedReady")("Ready", {}) {
      }
      const states = Machine.state({ states: { Idle } })
      const Emissions = Machine.emittedEventsFromSchemas(Ready)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(),
        emittedEvents: Emissions
      }).handle({
        initial: {
          target: "Idle",
          decoded: true,
          data: new Idle({})
        },
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
  it.effect("commits each idle delivery before send returns in generic and compiled runtimes", () =>
    Effect.gen(function*() {
      const machine = makeFlatMachine()
      const traces: Array<ReadonlyArray<unknown>> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        const trace: Array<unknown> = []
        for (const event of [new Noop({}), new Increment({}), new Reenter({}), new Increment({}), new Finish({})]) {
          Effect.runSync(ref.send(event))
          const snapshot = Effect.runSync(ref.snapshot)
          trace.push([snapshot.status, snapshot.state.state])
        }
        assert.strictEqual(yield* ref.join, 2)
        traces.push(trace)
      }
      assert.deepStrictEqual(traces[0], traces[1])
      assert.deepStrictEqual(traces[1], [
        ["active", { path: "Count", value: new Count({ value: 0 }) }],
        ["active", { path: "Count", value: new Count({ value: 1 }) }],
        ["active", { path: "Count", value: new Count({ value: 1 }) }],
        ["active", { path: "Count", value: new Count({ value: 2 }) }],
        ["done", { path: "Done", value: new Done({ value: 2 }) }]
      ])
    }) as Effect.Effect<void, unknown, any>)
  it.effect("commits raised events beside an active invocation before send returns in generic and compiled runtimes", () =>
    Effect.gen(function*() {
      let started: Deferred.Deferred<void> | undefined
      const Internal = Machine.internalEventsFromSchemas(Select)
      const machine = Machine.make({
        effects: {
          load: Effect.suspend(() => Deferred.succeed(started!, undefined)).pipe(Effect.andThen(Effect.never))
        },
        root: Machine.state({ states: { Count, Done: { schema: Done, type: "final", output: Schema.Number } } }),
        events: Machine.eventsFromSchemas(Increment, Finish),
        internalEvents: Internal
      }).handle({
        initial: { target: "Count", decoded: true, data: new Count({ value: 0 }) },
        states: {
          Count: {
            invoke: { src: "load", id: "load" },
            on: {
              Increment: {
                stay: true,
                commands: ({ state }, enqueue) => {
                  enqueue.raise(new Select({ value: state.value + 1 }))
                  return undefined
                }
              },
              Select: { target: "Count", decoded: true, data: ({ event }) => new Count({ value: event.value }) },
              Finish: { target: "Done", decoded: true, data: ({ state }) => new Done({ value: state.value }) }
            }
          },
          Done: { output: ({ state }) => state.value }
        }
      })
      const traces: Array<ReadonlyArray<unknown>> = []
      for (const strategy of ["generic", "compiled"] as const) {
        started = yield* Deferred.make<void>()
        const ref = yield* openWithRuntimeStrategy(machine, strategy)
        // Delivery is synchronous once startup has settled and the machine is
        // idle; events sent during startup queue behind it.
        yield* Deferred.await(started)
        yield* Effect.yieldNow
        const retained = Effect.runSync(ref.snapshot)
        const trace: Array<unknown> = []
        for (const event of [new Increment({}), new Increment({})]) {
          Effect.runSync(ref.send(event))
          const snapshot = Effect.runSync(ref.snapshot)
          trace.push([snapshot.status, snapshot.state.state])
        }
        trace.push(retained.state.state)
        yield* ref.stop
        traces.push(trace)
      }
      assert.deepStrictEqual(traces[0], traces[1])
      assert.deepStrictEqual(traces[1], [
        ["active", { path: "Count", value: new Count({ value: 1 }) }],
        ["active", { path: "Count", value: new Count({ value: 2 }) }],
        { path: "Count", value: new Count({ value: 0 }) }
      ])
    }) as Effect.Effect<void, unknown, any>)
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
  it.effect("matches generic and indexed invoke failure traces", () =>
    Effect.gen(function*() {
      class Loading extends Schema.TaggedClass<Loading>("StrategyInvokeFailureLoading")("Loading", {}) {
      }
      class Failed extends Schema.TaggedClass<Failed>("StrategyInvokeFailureFailed")("Failed", {
        error: Schema.String
      }) {
      }
      const states = Machine.state({
        states: {
          Loading,
          Failed: { schema: Failed, type: "final", output: Schema.String }
        }
      })
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.fail("unavailable")) },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: "Loading",
          decoded: true,
          data: new Loading({})
        },
        states: {
          Loading: {
            invoke: {
              src: "source1",
              id: "load",
              onFailure: { target: "Failed", decoded: true, data: ({ error }) => (new Failed({ error })) }
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
      class ChildIdle extends Schema.TaggedClass<ChildIdle>("StrategyRequiredParentChildIdle")("ChildIdle", {}) {
      }
      class ParentWaiting
        extends Schema.TaggedClass<ParentWaiting>("StrategyRequiredParentWaiting")("ParentWaiting", {})
      {
      }
      class ParentDone extends Schema.TaggedClass<ParentDone>("StrategyRequiredParentDone")("ParentDone", {}) {
      }
      class ChildReady extends Schema.TaggedClass<ChildReady>("StrategyRequiredParentReady")("ChildReady", {}) {
      }
      const ParentEvents = Machine.eventsFromSchemas(ChildReady)
      const childStates = Machine.state({ states: { ChildIdle } })
      const childMachine = Machine.make({
        effects: {
          source1: ({ parent }: Machine.Machine.InvokeContext<
            {
              readonly "": {
                readonly initial: "ChildIdle"
                readonly states: {
                  readonly ChildIdle: typeof ChildIdle
                }
              } & {
                readonly "~effect/Machine/ExplicitInitial": true
              }
            },
            readonly [],
            readonly [],
            "ChildIdle",
            readonly [],
            Machine.Machine.ParentEventSchemas<
              "required",
              readonly [
                typeof ChildReady
              ]
            >
          >) => parent.send(ParentEvents.ChildReady())
        },
        root: childStates,
        events: Machine.eventsFromSchemas(),
        parent: Machine.parent(ParentEvents)
      }).handle({
        initial: {
          target: "ChildIdle",
          decoded: true,
          data: new ChildIdle({})
        },
        states: {
          ChildIdle: {
            invoke: {
              src: "source1",
              id: "notify-parent",
              input: (context) => context,
              onDone: { stay: true },
              onFailure: { stay: true }
            }
          }
        }
      })
      const Child = Machine.child("required-parent-child", childMachine)
      const parentStates = Machine.state({
        states: {
          ParentWaiting,
          ParentDone: { schema: ParentDone, type: "final", output: Schema.String }
        }
      })
      const parentMachine = Machine.make({
        children: { source1: Child },
        root: parentStates,
        events: ParentEvents
      }).handle({
        initial: {
          target: "ParentWaiting",
          decoded: true,
          data: new ParentWaiting({})
        },
        states: {
          ParentWaiting: {
            invoke: { src: "source1" },
            on: {
              ChildReady: { target: "ParentDone", decoded: true, data: () => (new ParentDone({})) }
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
  it.effect("fails closed to generic planning for an owner update that enters a choice", () =>
    Effect.gen(function*() {
      const States = Machine.state({
        states: {
          Flow: {
            fields: { count: Schema.Number },
            states: { Idle: {}, First: { type: "choice" }, Second: { type: "choice" }, Even: {}, Odd: {} }
          }
        }
      })
      const Events = Machine.events({ Bump: {}, Stay: {}, Reset: {} })
      const machine = Machine.make({
        root: States,
        events: Events
      }).handle({
        initial: { target: "Flow", data: { count: 0 } },
        states: {
          Flow: {
            on: { Reset: { update: { Flow: () => ({ count: 0 }) } } },
            initial: { target: "Flow.Idle" },
            states: {
              Idle: {
                on: {
                  Bump: {
                    target: "Flow.First",
                    update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                  }
                }
              },
              First: {
                choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
              },
              Second: {
                choice: {
                  branches: [{ target: "Flow.Even" }, { target: "Flow.Odd" }],
                  resolve: ({ containingState, select }) =>
                    containingState.count % 2 === 0 ? select.target("Flow.Even") : select.target("Flow.Odd")
                }
              },
              Even: {
                on: {
                  Stay: {
                    target: "Flow.First",
                    update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 2 }) },
                    reenter: true
                  }
                }
              },
              Odd: {
                on: {
                  Bump: {
                    target: "Flow.First",
                    update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                  }
                }
              }
            }
          }
        }
      })
      assert.strictEqual(ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy, "generic")
      assert.throws(
        () => ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-hierarchical"),
        /cannot compile the requested indexed-hierarchical execution plan/
      )
      const events = [Events.Bump(), Events.Bump(), Events.Stay(), Events.Reset(), Events.Bump()]
      yield* verifyPlannerStrategies({ machine, events, expected: "generic", label: "choice owner update" })
      const initial = yield* Machine.planInitial(machine)
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
          label: `${strategy} choice owner update runtime`
        })
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
      const samples = yield* Arbitrary.sampleEffect(generated.arbitrary, { count: 120, seed: 81109 })
      let compared = 0
      for (let index = 0; index < samples.length && compared < 24; index++) {
        const model = samples[index]!
        const machine = MachineTest.compileModel(model)
        const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, "auto").strategy
        if (selected === "generic") {
          continue
        }
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
    }), 30000)
  it.effect("matches generic and indexed planning for current and retired invocation generations", () =>
    Effect.gen(function*() {
      const Result = { fields: { result: Schema.Number } }
      const Events = Machine.events({ Restart: {} })
      const flat = Machine.make({
        root: Machine.state({ states: { Working: {}, Done: Result } }),
        events: Events,
        // Planning never runs the source.
        effects: { work: Effect.succeed(1) }
      }).handle({
        initial: { target: "Working" },
        states: {
          Working: {
            invoke: { src: "work", id: "work", onDone: { target: "Done", data: () => ({ result: 1 }) } },
            on: { Restart: { reenter: true } }
          },
          Done: {}
        }
      })
      const nested = Machine.make({
        root: Machine.state({ states: { Outer: { states: { Working: {} } }, Done: Result } }),
        events: Events,
        // Planning never runs the source.
        effects: { work: Effect.succeed(1) }
      }).handle({
        initial: { target: "Outer" },
        states: {
          Outer: {
            initial: { target: "Outer.Working" },
            states: {
              Working: {
                invoke: { src: "work", id: "work", onDone: { target: "Done", data: () => ({ result: 1 }) } },
                on: { Restart: { reenter: true } }
              }
            }
          },
          Done: {}
        }
      })
      for (
        const { expected, machine, path } of [
          { machine: flat as any, path: "Working", expected: "indexed-flat" },
          { machine: nested as any, path: "Outer.Working", expected: "indexed-hierarchical" }
        ] as const
      ) {
        const initial = yield* Machine.planInitial(machine)
        const active = Configuration.normalizeConfigurationSync(machine, initial.state)
        const generic = ExecutionPlan.selectExecutionPlanForTesting(machine, "generic")
        const selected = ExecutionPlan.selectExecutionPlanForTesting(machine, "auto")
        assert.strictEqual(selected.strategy, expected)
        for (const current of [true, false]) {
          const event = InvocationEvent.done(path, "work", { current }, 1)
          const results = []
          for (const strategy of [generic, selected]) {
            const planned = strategy.plan.plan(strategy.plan.fromConfiguration(active), event, "Owned", true)
            results.push({
              next: yield* Machine.encodeSnapshot(machine, strategy.plan.snapshot(planned.next)),
              microsteps: planned.microsteps.map((step) => ({
                exitPaths: step.exitPaths,
                entryPaths: step.entryPaths,
                changed: step.changed
              })),
              done: planned.done
            })
          }
          assert.deepStrictEqual(results[1], results[0], `${expected} ${current ? "current" : "retired"} generation`)
          assert.strictEqual(results[0]!.microsteps.length, current ? 1 : 0)
          if (!current) {
            assert.deepStrictEqual(results[0]!.next, yield* Machine.encodeSnapshot(machine, initial.state))
          }
        }
      }
    }) as Effect.Effect<void, unknown, any>)
  it.effect("matches generic and compiled managed runtimes when a stale invocation result is queued", () =>
    Effect.scoped(Effect.gen(function*() {
      const results: Array<unknown> = []
      for (const strategy of ["generic", "compiled"] as const) {
        const holdEntered = yield* Deferred.make<void>()
        const releaseHold = yield* Deferred.make<void>()
        const attempts = [yield* Deferred.make<number>(), yield* Deferred.make<number>()]
        const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
        let count = 0
        const gate: Machine.MachineTarget<void> = {
          id: "gate",
          sessionId: "gate-session",
          send: () =>
            Deferred.succeed(holdEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseHold)), Effect.asVoid)
        }
        const machine = Machine.make({
          id: "strategy-stale-owner",
          root: Machine.state({
            states: { Working: {}, Done: { type: "final", fields: { result: Schema.Number }, output: Schema.Number } }
          }),
          events: Machine.events({ Hold: {}, Restart: {} }),
          effects: {
            work: Effect.suspend(() => {
              const n = count++
              return Deferred.succeed(started[n]!, undefined).pipe(Effect.andThen(Deferred.await(attempts[n]!)))
            })
          }
        }).handle({
          initial: { target: "Working" },
          on: { Hold: { stay: true, commands: (_, enqueue) => enqueue.sendTo(gate, undefined) } },
          states: {
            Working: {
              invoke: {
                src: "work",
                id: "work",
                onDone: { target: "Done", data: ({ output }) => ({ result: output }) }
              },
              on: { Restart: { target: "Working", reenter: true } }
            },
            Done: { output: ({ state }) => state.result }
          }
        })
        const prepared = yield* prepareWithRuntimeStrategy(machine, strategy)
        const queued = yield* Deferred.make<void>()
        const observed = yield* prepared.inspection.pipe(
          Stream.tap((record) =>
            record._tag === "EventSent" && InvocationEvent.isInvocationEvent(record.event)
              ? Deferred.succeed(queued, undefined)
              : Effect.void
          ),
          Stream.filter((record) => record._tag === "EventProcessed"),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true })
        )
        const ref = yield* prepared.start
        yield* Deferred.await(started[0]!)
        yield* ref.send({ _tag: "Hold" })
        yield* Deferred.await(holdEntered)
        yield* ref.send({ _tag: "Restart" })
        yield* Deferred.succeed(attempts[0]!, 1)
        yield* Deferred.await(queued)
        yield* Deferred.succeed(releaseHold, undefined)
        yield* Deferred.await(started[1]!)
        yield* Deferred.succeed(attempts[1]!, 2)
        const output = yield* ref.join
        const processed = yield* Effect.forEach(
          Array.from(yield* Fiber.join(observed)),
          (record) =>
            record._tag === "EventProcessed"
              ? Effect.map(
                (record.after.status === "active" || record.after.status === "done"
                  ? Machine.encodeSnapshot(machine, record.after.state as never)
                  : Effect.succeed(record.after.status)) as Effect.Effect<unknown, unknown>,
                (after) => ({
                  event: InvocationEvent.isInvocationEvent(record.event)
                    ? { path: record.event.path, type: record.event.type }
                    : record.event,
                  handled: record.handled,
                  after
                })
              )
              : Effect.die("unexpected record")
        )
        results.push({ output, processed })
      }
      assert.deepStrictEqual(results[1], results[0])
      const { output, processed } = results[0] as {
        output: number
        processed: ReadonlyArray<{ readonly event: unknown; readonly handled: boolean }>
      }
      assert.strictEqual(output, 2)
      assert.deepStrictEqual(processed.map(({ event, handled }) => [event, handled]), [
        [{ _tag: "Hold" }, true],
        [{ _tag: "Restart" }, true],
        [{ path: "Working", type: "done" }, false],
        [{ path: "Working", type: "done" }, true]
      ])
    }) as Effect.Effect<void, unknown, any>))

  describe("execution state ownership", () => {
    const machine = Machine.make({
      root: Machine.state({ states: { Count: { fields: { value: Schema.Number } } } }),
      events: Machine.events({ Increment: {}, Twice: {}, Overflow: {}, Burst: {} })
    }).handle({
      initial: { target: "Count", data: { value: 0 } },
      states: {
        Count: {
          on: {
            Increment: { target: "Count", data: ({ state }) => ({ value: state.value + 1 }) },
            // Writes the value twice in one plan, the second time for a raised event.
            Twice: {
              target: "Count",
              data: ({ state }) => ({ value: state.value + 1 }),
              commands: (_, enqueue) => enqueue.raise({ _tag: "Increment" })
            },
            // Writes the value, then raises an event whose transition throws.
            Overflow: {
              target: "Count",
              data: ({ state }) => ({ value: state.value + 10 }),
              commands: (_, enqueue) => enqueue.raise({ _tag: "Burst" })
            },
            Burst: {
              target: "Count",
              data: ({ state }) => {
                if (state.value >= 10) throw new Error("overflow")
                return { value: state.value }
              }
            }
          }
        }
      }
    })
    const valueOf = (plan: ExecutionPlan.CompiledExecutionPlan, state: unknown) =>
      (plan.snapshot(state) as unknown as { readonly state: { readonly value: { readonly value: number } } }).state
        .value.value

    const initial = (plan: ExecutionPlan.CompiledExecutionPlan) =>
      plan.fromConfiguration(
        Configuration.normalizeConfigurationSync(machine, Effect.runSync(Machine.planInitial(machine)).state)
      )

    it("plans a persistent state without writing it, and plans it again alike", () => {
      const plan = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan
      const state = initial(plan)
      const first = plan.plan(state, { _tag: "Increment" }, "Persistent", true)
      const again = plan.plan(state, { _tag: "Increment" }, "Persistent", true)
      assert.strictEqual(valueOf(plan, state), 0)
      assert.strictEqual(valueOf(plan, first.next), 1)
      assert.strictEqual(valueOf(plan, again.next), 1)
      assert.notStrictEqual(first.next, again.next)
      // A retained microstep keeps its state while a later persistent plan goes on from it.
      const next = plan.plan(first.next, { _tag: "Increment" }, "Persistent", true)
      assert.strictEqual(valueOf(plan, first.microsteps[0]!.next), 1)
      assert.strictEqual(valueOf(plan, next.next), 2)
    })

    it("updates an owned state in place, and leaves it as it was when the plan throws", () => {
      const plan = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan
      const state = initial(plan)
      const incremented = plan.plan(state, { _tag: "Increment" }, "Owned", false)
      assert.strictEqual(incremented.next, state)
      assert.strictEqual(valueOf(plan, state), 1)
      assert.throws(() => plan.plan(state, { _tag: "Overflow" }, "Owned", true), /overflow/)
      assert.strictEqual(valueOf(plan, state), 1)
    })

    it("keeps each retained microstep of an owned plan while later microsteps write in place", () => {
      const plan = ExecutionPlan.selectExecutionPlanForTesting(machine, "indexed-flat").plan
      const planned = plan.plan(initial(plan), { _tag: "Twice" }, "Owned", true)
      assert.deepStrictEqual(planned.microsteps.map((step) => valueOf(plan, step.next)), [1, 2])
      assert.strictEqual(valueOf(plan, planned.next), 2)
      // Without retained microsteps, the plan writes one state throughout.
      const unretained = plan.plan(initial(plan), { _tag: "Twice" }, "Owned", false)
      assert.strictEqual(unretained.microsteps[0]!.next, unretained.next)
    })
  })
})
