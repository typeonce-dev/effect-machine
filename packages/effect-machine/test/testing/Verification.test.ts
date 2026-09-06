import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

class Off extends Schema.TaggedClass<Off>("Off")("Off", {}) {}
class App extends Schema.TaggedClass<App>("App")("App", {}) {}
class One extends Schema.TaggedClass<One>("One")("One", {}) {}
class Two extends Schema.TaggedClass<Two>("Two")("Two", {}) {}
class Go extends Schema.TaggedClass<Go>("Go")("Go", {}) {}
class Counter extends Schema.TaggedClass<Counter>("Counter")("Counter", {
  count: Schema.Int
}) {}
class Increment extends Schema.TaggedClass<Increment>("Increment")("Increment", {}) {}
class Noop extends Schema.TaggedClass<Noop>("Noop")("Noop", {}) {}
class Restart extends Schema.TaggedClass<Restart>("Restart")("Restart", {}) {}
class Route extends Schema.TaggedClass<Route>("VerificationRoute")("Route", {}) {}
class Select extends Schema.TaggedClass<Select>("VerificationSelect")("Select", {
  value: Schema.Int
}) {}

const NavigationStates = Machine.state({
  initial: "off",
  states: {
    off: Off,
    app: {
      schema: App,
      initial: "one",
      states: {
        one: One,
        two: Two
      }
    }
  }
})

const navigationMachine = Machine.make({
  root: NavigationStates,
  events: Machine.eventsFromSchemas(Go)
}).handle({
  states: {
    off: {
      on: {
        Go: (to) =>
          to.branch.app().resolve(({ target }) => target.decoded(new App({}), (app) => app.two.decoded(new Two({}))))
      }
    }
  }
})

const raisedNavigationMachine = Machine.make({
  root: NavigationStates,
  events: Machine.eventsFromSchemas(Go),
  initialConfiguration: (root) => root.resolve(({ target }) => target.from((to) => to.off.decoded(new Off({}))))
}).handle({
  states: {
    off: {
      always: (to) =>
        to.branch.app().resolve(({ target }) => target.decoded(new App({}), (app) => app.one.decoded(new One({})))),
      on: {
        Go: (to) =>
          to.branch.app().resolve(({ target }) => target.decoded(new App({}), (app) => app.one.decoded(new One({}))))
      }
    }
  }
})

const CounterStates = Machine.state({ initial: "counter", states: { counter: Counter } })

const counterMachine = Machine.make({
  root: CounterStates,
  events: Machine.eventsFromSchemas(Increment, Noop),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.counter.decoded(new Counter({ count: 0 }))))
}).handle({
  states: {
    counter: {
      on: {
        Increment: (to) =>
          to.branch.counter().resolve(({ state, target }) => target.decoded(new Counter({ count: state.count + 1 }))),
        Noop: (to) => to.none
      }
    }
  }
})

const conditionalMachine = Machine.make({
  root: CounterStates,
  events: Machine.eventsFromSchemas(Select),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.counter.decoded(new Counter({ count: 0 }))))
}).handle({
  states: {
    counter: {
      on: {
        Select: (to) =>
          to.branches({
            negative: { target: to.none },
            zero: { target: to.branch.counter() },
            positive: { target: to.none }
          }).resolve(({ event, select }) =>
            event.value < 0
              ? select.negative()
              : event.value === 0
              ? select.zero.decoded(new Counter({ count: 0 }))
              : select.positive()
          )
      }
    }
  }
})

const invokedMachine = Machine.make({
  root: CounterStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.counter.decoded(new Counter({ count: 0 }))))
}).handle({
  states: {
    counter: {
      invoke: (
        from
      ) => [
        from.effect("first", () => Effect.succeed(1)).onDone((to) => to.none),
        from.effect("second", () => Effect.succeed(2)).onDone((to) => to.none)
      ]
    }
  }
})

class StartupA extends Schema.TaggedClass<StartupA>("StartupA")("StartupA", {}) {}
class StartupB extends Schema.TaggedClass<StartupB>("StartupB")("StartupB", {}) {}

const RoutedStartupStates = Machine.state({
  initial: "b",
  states: {
    a: {
      schema: StartupA,
      initial: "route",
      states: {
        route: { type: "choice" },
        second: { type: "choice" }
      }
    },
    b: StartupB
  }
})

const routedStartupMachine = Machine.make({
  root: RoutedStartupStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.a.decoded(new StartupA({}), (a) => a.route())))
}).handle({
  states: {
    a: {
      states: {
        route: {
          choice: (to) => to.local.second().resolve(({ target }) => target())
        },
        second: {
          choice: (to) => to.branch.b().resolve(({ target }) => target.decoded(new StartupB({})))
        }
      }
    },
    b: {}
  }
})

class ChoiceFlow extends Schema.TaggedClass<ChoiceFlow>("ChoiceFlow")("ChoiceFlow", {}) {}
class ChoiceReady extends Schema.TaggedClass<ChoiceReady>("ChoiceReady")("ChoiceReady", {}) {}
class ChoiceRouted extends Schema.TaggedClass<ChoiceRouted>("ChoiceRouted")("ChoiceRouted", {}) {}

const ChoiceResolutionStates = Machine.state({
  initial: "flow",
  states: {
    flow: {
      schema: ChoiceFlow,
      initial: "ready",
      states: {
        ready: ChoiceReady,
        first: { type: "choice" },
        second: { type: "choice" },
        routed: ChoiceRouted
      }
    }
  }
})

const choiceResolutionMachine = Machine.make({
  root: ChoiceResolutionStates,
  events: Machine.eventsFromSchemas(Route),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.flow.decoded(new ChoiceFlow({}), (flow) => flow.ready.decoded(new ChoiceReady({}))))
    )
}).handle({
  states: {
    flow: {
      states: {
        ready: {
          on: {
            Route: (to) => to.local.first().resolve(({ target }) => target())
          }
        },
        first: {
          choice: (to) => to.local.second().resolve(({ target }) => target())
        },
        second: {
          choice: (to) => to.local.routed().resolve(({ target }) => target.decoded(new ChoiceRouted({})))
        },
        routed: {}
      }
    }
  }
})

const reentryMachine = Machine.make({
  root: NavigationStates,
  events: Machine.eventsFromSchemas(Restart),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.app.decoded(new App({}), (app) => app.one.decoded(new One({}))))
    )
}).handle({
  states: {
    app: {
      on: {
        Restart: (to) =>
          to.branch.app().resolve(({ target }) => target.decoded(new App({}), (app) => app.one.decoded(new One({}))), {
            reenter: true
          })
      }
    }
  }
})

class Dashboard extends Schema.TaggedClass<Dashboard>("Dashboard")("Dashboard", {}) {}
class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}

const ParallelStates = Machine.state({
  initial: "dashboard",
  states: {
    dashboard: {
      schema: Dashboard,
      type: "parallel",
      states: {
        left: Left,
        right: Right
      }
    }
  }
})

const parallelMachine = Machine.make({
  root: ParallelStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.dashboard.decoded(
          new Dashboard({}),
          (dashboard) => dashboard.left.decoded(new Left({})).right.decoded(new Right({}))
        )
      )
    )
}).handle({ states: { dashboard: {} } })

class Workspace extends Schema.TaggedClass<Workspace>("Workspace")("Workspace", {}) {}
class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {}) {}
class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {
  revision: Schema.Int
}) {}
class Away extends Schema.TaggedClass<Away>("Away")("Away", {}) {}
class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {}
class Resume extends Schema.TaggedClass<Resume>("Resume")("Resume", {}) {}

const HistoryStates = Machine.state({
  initial: "away",
  states: {
    workspace: {
      schema: Workspace,
      initial: "editor",
      states: {
        editor: {
          schema: Editor,
          initial: "editing",
          states: {
            editing: Editing
          }
        },
        recent: {
          type: "history"
        },
        exact: {
          type: "history",
          history: "deep"
        }
      }
    },
    away: Away
  }
})

const historyMachine = Machine.make({
  root: HistoryStates,
  events: Machine.eventsFromSchemas(Leave, Resume),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.workspace.decoded(new Workspace({}), (workspace) =>
          workspace.editor.decoded(
            new Editor({}),
            (editor) => editor.editing.decoded(new Editing({ revision: 1 }))
          ))
      )
    )
}).handle({
  states: {
    workspace: {
      history: {
        recent: {
          default: ({ target }) =>
            target.from((to) =>
              to.workspace.decoded(new Workspace({}), (workspace) =>
                workspace.editor.decoded(
                  new Editor({}),
                  (editor) => editor.editing.decoded(new Editing({ revision: 0 }))
                ))
            )
        },
        exact: {
          default: ({ target }) =>
            target.from((to) =>
              to.workspace.decoded(new Workspace({}), (workspace) =>
                workspace.editor.decoded(
                  new Editor({}),
                  (editor) => editor.editing.decoded(new Editing({ revision: 0 }))
                ))
            )
        }
      },
      on: {
        Leave: (to) => to.branch.away().resolve(({ target }) => target.decoded(new Away({})))
      },
      states: {
        editor: {
          initialize: ({ builder }) => builder.decoded(new Editing({ revision: 0 }))
        }
      }
    },
    away: {
      on: {
        Resume: (to) => to.history.workspace.exact.resolve(({ target }) => target())
      }
    }
  }
})

const StructuralHistoryStates = Machine.state({
  initial: "away",
  states: {
    workspace: {
      initial: "editor",
      states: {
        editor: {
          initial: "idle",
          states: { idle: {} }
        },
        exact: { type: "history", history: "deep" }
      }
    },
    away: {}
  }
})

const structuralHistoryInitial = () => ({
  path: "" as const,
  value: undefined,
  state: {
    path: "workspace" as const,
    value: undefined,
    state: {
      path: "workspace.editor" as const,
      value: undefined,
      state: { path: "workspace.editor.idle" as const, value: undefined }
    }
  }
})

const structuralHistoryMachine = Machine.make({
  root: StructuralHistoryStates,
  events: Machine.eventsFromSchemas(Leave),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) => to.workspace.from((workspace) => workspace.editor.from((editor) => editor.idle.from())))
    )
}).handle({
  states: {
    workspace: {
      history: {
        exact: { default: structuralHistoryInitial }
      },
      on: {
        Leave: (to) => to.branch.away().resolve(({ target }) => target.from())
      }
    }
  }
})

class Finished extends Schema.TaggedClass<Finished>("Finished")("Finished", {}) {}

const CompletionStates = Machine.state({
  initial: "finished",
  states: {
    finished: {
      schema: Finished,
      type: "final",
      output: Schema.String
    }
  }
})

const completionMachine = Machine.make({
  root: CompletionStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) => target.from((to) => to.finished.decoded(new Finished({}))))
}).handle({
  states: {
    finished: {
      output: () => "complete"
    }
  }
})

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Archived extends Schema.TaggedClass<Archived>("Archived")("Archived", {}) {}

const DoneTransitionStates = Machine.state({
  initial: "workflow",
  states: {
    workflow: {
      schema: Workflow,
      initial: "finished",
      states: {
        finished: {
          schema: Finished,
          type: "final",
          output: Schema.String
        }
      }
    },
    archived: Archived
  }
})

const doneTransitionMachine = Machine.make({
  root: DoneTransitionStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.workflow.decoded(new Workflow({}), (workflow) => workflow.finished.decoded(new Finished({})))
      )
    )
}).handle({
  states: {
    workflow: {
      onDone: (to) => to.branch.archived().resolve(({ target }) => target.decoded(new Archived({}))),
      states: {
        finished: {
          output: () => "workflow-output"
        }
      }
    }
  }
})

const nestedCompletionMachine = Machine.make({
  root: DoneTransitionStates,
  events: Machine.eventsFromSchemas(),
  initialConfiguration: (root) =>
    root.resolve(({ target }) =>
      target.from((to) =>
        to.workflow.decoded(new Workflow({}), (workflow) => workflow.finished.decoded(new Finished({})))
      )
    )
}).handle({
  states: {
    workflow: {
      states: {
        finished: {
          output: () => "nested-output"
        }
      }
    }
  }
})

const laws = (error: MachineTest.VerificationError): ReadonlyArray<MachineTest.VerificationLaw> =>
  error.violations.map((violation) => violation.law)

describe("MachineTest.verify", () => {
  it.effect("accepts structural configurations and history without invented values", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(structuralHistoryMachine, { events: [new Leave({})] })
      yield* MachineTest.verify(structuralHistoryMachine, trace)

      const valuedState = {
        ...trace,
        final: { ...trace.final, state: { ...trace.final.state, value: { _tag: "Invented" } } }
      } as unknown as typeof trace
      const stateError = yield* MachineTest.verify(structuralHistoryMachine, valuedState, {
        laws: ["configuration"]
      }).pipe(Effect.flip)
      assert.ok(
        stateError.violations.some((violation) => violation.law === "configuration.schema" && violation.path === "away")
      )

      const final = trace.final as any
      const exact = final.history["workspace.exact"]
      const valuedHistory = {
        ...trace,
        final: {
          ...final,
          history: {
            ...final.history,
            "workspace.exact": {
              ...exact,
              values: { ...exact.values, workspace: { _tag: "Invented" } }
            }
          }
        }
      } as typeof trace
      const historyError = yield* MachineTest.verify(structuralHistoryMachine, valuedHistory, {
        laws: ["history"]
      }).pipe(Effect.flip)
      assert.ok(
        historyError.violations.some((violation) => violation.law === "history.value" && violation.path === "workspace")
      )
    }))

  it.effect("accepts valid compound, parallel, history, and completion traces", () =>
    Effect.gen(function*() {
      const navigation = yield* MachineTest.run(navigationMachine, { events: [new Go({})] })
      const raisedNavigation = yield* MachineTest.run(raisedNavigationMachine, { events: [] })
      const parallel = yield* MachineTest.run(parallelMachine, { events: [] })
      const history = yield* MachineTest.run(historyMachine, { events: [new Leave({})] })
      const completion = yield* MachineTest.run(completionMachine, { events: [] })
      const doneTransition = yield* MachineTest.run(doneTransitionMachine, { events: [] })
      const nestedCompletion = yield* MachineTest.run(nestedCompletionMachine, { events: [] })

      yield* MachineTest.verify(navigationMachine, navigation)
      yield* MachineTest.verify(raisedNavigationMachine, raisedNavigation)
      yield* MachineTest.verify(parallelMachine, parallel)
      yield* MachineTest.verify(historyMachine, history)
      yield* MachineTest.verify(completionMachine, completion)
      yield* MachineTest.verify(doneTransitionMachine, doneTransition)
      yield* MachineTest.verify(nestedCompletionMachine, nestedCompletion)
    }))

  it.effect("allows same-path value updates while rejecting implausible changed no-ops", () =>
    Effect.gen(function*() {
      const updated = yield* MachineTest.run(counterMachine, { events: [new Increment({})] })
      const updateMicrostep = updated.steps[0]!.plan.microsteps[0]!
      assert.strictEqual(updateMicrostep.changed, false)
      assert.deepStrictEqual(updateMicrostep.exitPaths, [])
      assert.deepStrictEqual(updateMicrostep.entryPaths, [])
      assert.strictEqual((updated.final.state.value as Counter).count, 1)
      yield* MachineTest.verify(counterMachine, updated)

      const noop = yield* MachineTest.run(counterMachine, { events: [new Noop({})] })
      const step = noop.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const corrupted = {
        ...noop,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{ ...microstep, changed: true }]
          }
        }]
      } as typeof noop
      const error = yield* MachineTest.verify(counterMachine, corrupted, {
        laws: ["microsteps"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "microsteps.changed")
    }))

  it.effect("requires lifecycle boundaries to match retained reentry scopes", () =>
    Effect.gen(function*() {
      const reentry = yield* MachineTest.run(reentryMachine, { events: [new Restart({})] })
      yield* MachineTest.verify(reentryMachine, reentry)
      const step = reentry.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const missingBoundary = {
        ...reentry,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              exitPaths: microstep.exitPaths.filter((path) => path !== "app"),
              entryPaths: microstep.entryPaths.filter((path) => path !== "app")
            }]
          }
        }]
      } as typeof reentry
      const missingError = yield* MachineTest.verify(reentryMachine, missingBoundary, {
        laws: ["microsteps"]
      }).pipe(Effect.flip)
      assert.ok(
        missingError.violations.some((violation) => violation.law === "microsteps.reentry" && violation.path === "app")
      )

      const updated = yield* MachineTest.run(counterMachine, { events: [new Increment({})] })
      const updateStep = updated.steps[0]!
      const updateMicrostep = updateStep.plan.microsteps[0]!
      const spuriousLifecycle = {
        ...updated,
        steps: [{
          ...updateStep,
          plan: {
            ...updateStep.plan,
            microsteps: [{
              ...updateMicrostep,
              changed: true,
              exitPaths: ["counter"],
              entryPaths: ["counter"]
            }]
          }
        }]
      } as typeof updated
      const spuriousError = yield* MachineTest.verify(counterMachine, spuriousLifecycle, {
        laws: ["microsteps"]
      }).pipe(Effect.flip)
      assert.ok(spuriousError.violations.some((violation) =>
        violation.law === "microsteps.reentry" && violation.path === "counter"
      ))
    }))

  it.effect("reports omitted parallel regions and duplicate active states", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(parallelMachine, { events: [] })
      const final = trace.final as any
      const omitted = {
        ...trace,
        final: {
          ...final,
          state: { ...final.state, states: { left: final.state.states.left } }
        }
      } as typeof trace
      const omittedError = yield* MachineTest.verify(parallelMachine, omitted, {
        laws: ["configuration"]
      }).pipe(Effect.flip)
      assert.include(laws(omittedError), "configuration.parallel")

      const duplicate = {
        ...trace,
        final: {
          ...final,
          state: { ...final.state, states: { left: final.state.states.left, right: final.state.states.left } }
        }
      } as typeof trace
      const duplicateError = yield* MachineTest.verify(parallelMachine, duplicate, {
        laws: ["configuration"]
      }).pipe(Effect.flip)
      assert.include(laws(duplicateError), "configuration.duplicate")
    }))

  it.effect("reports reversed entry order with its event and microstep", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(navigationMachine, { events: [new Go({})] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const reversed = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{ ...microstep, entryPaths: [...microstep.entryPaths].reverse() }]
          }
        }]
      } as typeof trace

      const error = yield* MachineTest.verify(navigationMachine, reversed, {
        laws: ["microsteps"]
      }).pipe(Effect.flip)
      const violation = error.violations.find(({ law }) => law === "microsteps.order")
      assert.strictEqual(violation?.eventIndex, 0)
      assert.strictEqual(violation?.microstepIndex, 0)
    }))

  it.effect("reports unknown and active history paths", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(historyMachine, { events: [] })
      const workspace = trace.final as any

      const unknown = {
        ...trace,
        final: {
          ...workspace,
          state: { path: "workspace.missing" as const, value: new Editing({ revision: 1 }) }
        }
      } as typeof trace
      const unknownError = yield* MachineTest.verify(historyMachine, unknown, {
        laws: ["configuration"]
      }).pipe(Effect.flip)
      assert.include(laws(unknownError), "configuration.path")

      const activeHistory = {
        ...trace,
        final: {
          ...workspace,
          state: { path: "workspace.recent" as const, value: new Editing({ revision: 1 }) }
        }
      } as typeof trace
      const historyError = yield* MachineTest.verify(historyMachine, activeHistory, {
        laws: ["configuration"]
      }).pipe(Effect.flip)
      assert.ok(historyError.violations.some((violation) =>
        violation.law === "configuration.path" && violation.path === "workspace.recent"
      ))
    }))

  it.effect("reports invalid remembered values in public history metadata", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(historyMachine, { events: [new Leave({})] })
      const final = trace.final as any
      const record = final.history["workspace.recent"]
      const corrupted = {
        ...trace,
        final: {
          ...final,
          history: {
            ...final.history,
            "workspace.recent": {
              ...record,
              values: {
                ...record.values,
                "workspace.editor": new Away({})
              }
            }
          }
        }
      } as typeof trace

      const error = yield* MachineTest.verify(historyMachine, corrupted, {
        laws: ["history"]
      }).pipe(Effect.flip)
      assert.ok(
        error.violations.some((violation) => violation.law === "history.value" && violation.path === "workspace.editor")
      )
    }))

  it.effect("distinguishes shallow containment from complete deep history", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(historyMachine, { events: [new Leave({})] })
      const final = trace.final as any
      const shallow = final.history["workspace.recent"]
      const deep = final.history["workspace.exact"]
      const corrupted = {
        ...trace,
        final: {
          ...final,
          history: {
            ...final.history,
            "workspace.recent": {
              ...shallow,
              active: [...shallow.active, "workspace.editor.editing"],
              values: {
                ...shallow.values,
                "workspace.editor.editing": new Editing({ revision: 1 })
              }
            },
            "workspace.exact": {
              ...deep,
              active: deep.active.filter((path: string) => path !== "workspace.editor.editing"),
              values: Object.fromEntries(
                Object.entries(deep.values).filter(([path]) => path !== "workspace.editor.editing")
              )
            }
          }
        }
      } as typeof trace

      const error = yield* MachineTest.verify(historyMachine, corrupted, {
        laws: ["history"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "history.shallow")
      assert.include(laws(error), "history.deep")
    }))

  it.effect("rejects orphan descendants in deep history", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(historyMachine, { events: [new Leave({})] })
      const final = trace.final as any
      const deep = final.history["workspace.exact"]
      const corrupted = {
        ...trace,
        final: {
          ...final,
          history: {
            ...final.history,
            "workspace.exact": {
              ...deep,
              active: deep.active.filter((path: string) => path !== "workspace.editor"),
              values: Object.fromEntries(
                Object.entries(deep.values).filter(([path]) => path !== "workspace.editor")
              )
            }
          }
        }
      } as typeof trace

      const error = yield* MachineTest.verify(historyMachine, corrupted, {
        laws: ["history"]
      }).pipe(Effect.flip)
      assert.ok(error.violations.some((violation) =>
        violation.law === "history.deep" && violation.message.includes("without ancestor")
      ))
    }))

  it.effect("reports inconsistent done and output data", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(completionMachine, { events: [] })
      const corrupted = {
        ...trace,
        initial: {
          ...trace.initial,
          plan: {
            ...trace.initial.plan,
            done: false,
            output: "not-allowed"
          }
        }
      } as unknown as typeof trace

      const error = yield* MachineTest.verify(completionMachine, corrupted, {
        laws: ["completion"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "completion.done")
      assert.include(laws(error), "completion.output")
    }))

  it.effect("requires every nested completion in settled snapshots", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(nestedCompletionMachine, { events: [] })
      const state = trace.initial.plan.state as any
      const corrupted = {
        ...trace,
        initial: {
          ...trace.initial,
          plan: {
            ...trace.initial.plan,
            state: {
              ...state,
              completed: state.completed.filter(({ path }: { readonly path: string }) => path !== "workflow.finished")
            }
          }
        }
      } as typeof trace

      const error = yield* MachineTest.verify(nestedCompletionMachine, corrupted, {
        laws: ["completion"]
      }).pipe(Effect.flip)
      assert.ok(error.violations.some((violation) =>
        violation.law === "completion.record" && violation.path === "workflow.finished"
      ))
    }))

  it.effect("binds retained targets to the exact selected branch and selection scope", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(navigationMachine, { events: [new Go({})] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const transition = microstep.transitions[0]!
      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, target: "off" }]
            }]
          }
        }]
      } as typeof trace

      const error = yield* MachineTest.verify(navigationMachine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      const violation = error.violations.find(({ law }) => law === "definitions.selection")
      assert.strictEqual(violation?.eventIndex, 0)
      assert.strictEqual(violation?.microstepIndex, 0)
      assert.strictEqual(violation?.path, "off")
    }))

  it.effect("rejects invalid named-branch evidence", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(conditionalMachine, { events: [new Select({ value: -1 })] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const transition = microstep.transitions[0]!

      const invalidIndex = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, branchIndex: 99 }]
            }]
          }
        }]
      } as typeof trace
      const indexError = yield* MachineTest.verify(conditionalMachine, invalidIndex, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(indexError), "definitions.branchIndex")

      const wrongKey = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, branchKey: "zero" }]
            }]
          }
        }]
      } as typeof trace
      const keyError = yield* MachineTest.verify(conditionalMachine, wrongKey, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(keyError), "definitions.branchKey")

      const crossBranch = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, branchIndex: 1, branchKey: "zero" }]
            }]
          }
        }]
      } as typeof trace
      const branchError = yield* MachineTest.verify(conditionalMachine, crossBranch, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(branchError), "definitions.selection")
    }))

  it.effect("accepts an exact initial choice route to another root", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(routedStartupMachine, { events: [] })

      assert.deepStrictEqual(trace.initial.startingConfiguration, ["", "b"])
      assert.deepStrictEqual(
        trace.initial.plan.microsteps[0]?.transitions.map(({ branchIndex, source, target, trigger }) => ({
          branchIndex,
          source: String(source),
          target,
          trigger: trigger.type
        })),
        [
          { branchIndex: 0, source: "a.route", target: "a.second", trigger: "choice" },
          { branchIndex: 0, source: "a.second", target: "b", trigger: "choice" }
        ]
      )
      yield* MachineTest.verify(routedStartupMachine, trace, { laws: ["definitions"] })
    }))

  it.effect("rejects a startup root without an exact initial choice route", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(navigationMachine, { events: [new Go({})] })
      const corrupted = {
        ...trace,
        initial: {
          ...trace.initial,
          startingState: trace.final
        }
      } as typeof trace

      const error = yield* MachineTest.verify(navigationMachine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      const violation = error.violations.find(({ law }) => law === "definitions.initial")
      assert.strictEqual(violation?.eventIndex, undefined)
      assert.strictEqual(violation?.path, "")
    }))

  it.effect("binds resolved targets to direct and chained choice evidence", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(choiceResolutionMachine, { events: [new Route({})] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      assert.deepStrictEqual(
        microstep.transitions.map(({ resolvedTarget, source, target }) => ({
          resolvedTarget,
          source: String(source),
          target
        })),
        [
          { source: "flow.ready", target: "flow.first", resolvedTarget: "flow.routed" },
          { source: "flow.first", target: "flow.second", resolvedTarget: "flow.second" },
          { source: "flow.second", target: "flow.routed", resolvedTarget: "flow.routed" }
        ]
      )
      yield* MachineTest.verify(choiceResolutionMachine, trace, { laws: ["definitions"] })

      const transition = microstep.transitions[0]!
      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, resolvedTarget: "flow" }, ...microstep.transitions.slice(1)]
            }]
          }
        }]
      } as typeof trace
      const error = yield* MachineTest.verify(choiceResolutionMachine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "definitions.resolution")

      const missingRoute = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{ ...microstep, transitions: [transition] }]
          }
        }]
      } as typeof trace
      const missingRouteError = yield* MachineTest.verify(choiceResolutionMachine, missingRoute, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.ok(missingRouteError.violations.some(({ law, message }) =>
        law === "definitions.resolution" && message.includes("without an exact retained route")
      ))
    }))

  it.effect("rejects a wrong active descendant as a resolved state target", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(navigationMachine, { events: [new Go({})] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      const transition = microstep.transitions[0]!
      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, resolvedTarget: "app.one" }]
            }]
          }
        }]
      } as typeof trace

      const error = yield* MachineTest.verify(navigationMachine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      const violation = error.violations.find(({ law }) => law === "definitions.resolution")
      assert.strictEqual(violation?.path, "app.one")
    }))

  it.effect("validates every simultaneous transition resolution independently", () =>
    Effect.gen(function*() {
      const machine = MachineTest.compileModel({
        roots: [{
          _tag: "Parallel",
          key: "workflow",
          value: 0,
          output: "done",
          states: [
            {
              _tag: "Compound",
              key: "left",
              value: 1,
              initial: "idle",
              states: [
                { _tag: "Atomic", key: "idle", value: 2 },
                { _tag: "Atomic", key: "done", value: 3 }
              ]
            },
            {
              _tag: "Compound",
              key: "right",
              value: 4,
              initial: "idle",
              states: [
                { _tag: "Atomic", key: "idle", value: 5 },
                { _tag: "Atomic", key: "done", value: 6 }
              ]
            }
          ]
        }],
        initial: "workflow",
        events: ["Advance"],
        transitions: [
          {
            source: "workflow.left.idle",
            trigger: { type: "event", event: "Advance" },
            target: "workflow.left.done",
            reenter: false
          },
          {
            source: "workflow.right.idle",
            trigger: { type: "event", event: "Advance" },
            target: "workflow.right.done",
            reenter: false
          }
        ]
      })
      const trace = yield* MachineTest.run(machine, { events: [{ _tag: "Advance" }] })
      const step = trace.steps[0]!
      const microstep = step.plan.microsteps[0]!
      assert.strictEqual(microstep.transitions.length, 2)

      const corrupted = {
        ...trace,
        steps: [{
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [
                { ...microstep.transitions[0]!, resolvedTarget: "workflow.left" },
                microstep.transitions[1]!
              ]
            }]
          }
        }]
      } as typeof trace
      const error = yield* MachineTest.verify(machine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "definitions.resolution")
    }))

  it.effect("binds history resolution to the declared owner", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(historyMachine, { events: [new Leave({}), new Resume({})] })
      const step = trace.steps[1]!
      const microstep = step.plan.microsteps[0]!
      const transition = microstep.transitions[0]!
      assert.deepStrictEqual(
        { target: transition.target, resolvedTarget: transition.resolvedTarget },
        { target: "workspace.exact", resolvedTarget: "workspace" }
      )
      yield* MachineTest.verify(historyMachine, trace, { laws: ["definitions"] })

      const corrupted = {
        ...trace,
        steps: [trace.steps[0]!, {
          ...step,
          plan: {
            ...step.plan,
            microsteps: [{
              ...microstep,
              transitions: [{ ...transition, resolvedTarget: "workspace.editor" }]
            }]
          }
        }]
      } as typeof trace
      const error = yield* MachineTest.verify(historyMachine, corrupted, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "definitions.resolution")
    }))

  it.effect("distinguishes invoke definitions by lifecycle id and outcome", () =>
    Effect.gen(function*() {
      const trace = yield* MachineTest.run(invokedMachine, { events: [] })
      const transition = {
        source: "counter" as const,
        trigger: { type: "invoke" as const, id: "second", outcome: "done" as const },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: undefined,
        resolvedTarget: undefined,
        updates: []
      }
      const microstep: MachineTest.Microstep<typeof invokedMachine> = {
        next: trace.initial.startingState,
        event: Machine.InitialEvent,
        transitions: [transition],
        commands: [],
        raisedEvents: [],
        emittedEvents: [],
        exitPaths: [],
        entryPaths: [],
        changed: false
      }
      const withInvoke = {
        ...trace,
        initial: {
          ...trace.initial,
          plan: {
            ...trace.initial.plan,
            microsteps: [microstep]
          }
        }
      }
      yield* MachineTest.verify(invokedMachine, withInvoke, { laws: ["definitions"] })

      const wrongId = {
        ...withInvoke,
        initial: {
          ...withInvoke.initial,
          plan: {
            ...withInvoke.initial.plan,
            microsteps: [{
              ...microstep,
              transitions: [{
                ...transition,
                trigger: { ...transition.trigger, id: "missing" }
              }]
            }]
          }
        }
      } as typeof withInvoke
      const error = yield* MachineTest.verify(invokedMachine, wrongId, {
        laws: ["definitions"]
      }).pipe(Effect.flip)
      assert.include(laws(error), "definitions.transition")
    }))

  const generatedNavigation = MachineTest.scenarios(navigationMachine, {
    minEvents: 0,
    maxEvents: 20
  })

  it.effect.prop(
    "verifies schema-derived scenarios after every shrink",
    { scenario: generatedNavigation.arbitrary },
    ({ scenario }) =>
      MachineTest.run(navigationMachine, scenario).pipe(
        Effect.flatMap((trace) => MachineTest.verify(navigationMachine, trace))
      ),
    { fastCheck: { numRuns: 50 } }
  )
})
