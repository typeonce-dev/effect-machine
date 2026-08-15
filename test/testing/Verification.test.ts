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

const NavigationStates = Machine.defineStates({
  off: Off,
  app: {
    schema: App,
    initial: "one",
    states: {
      one: One,
      two: Two
    }
  }
})

const navigationMachine = Machine.make({
  states: NavigationStates.states,
  events: Machine.events(Go),
  initial: () => NavigationStates.initial.off(new Off({}))
}).handle({
  off: {
    on: {
      Go: {
        targets: ["app"],
        transition: ({ target }) => target.full.app(new App({}), (app) => app.two(new Two({})))
      }
    }
  }
})

const raisedNavigationMachine = Machine.make({
  states: NavigationStates.states,
  events: Machine.events(Go),
  initial: () => NavigationStates.initial.off(new Off({}))
}).handle({
  off: {
    always: ({ target }) => target.full.app(new App({}), (app) => app.one(new One({}))),
    on: {
      Go: ({ target }) => target.full.app(new App({}), (app) => app.one(new One({})))
    }
  }
})

const CounterStates = Machine.defineStates({ counter: Counter })

const counterMachine = Machine.make({
  states: CounterStates.states,
  events: Machine.events(Increment, Noop),
  initial: () => CounterStates.initial.counter(new Counter({ count: 0 }))
}).handle({
  counter: {
    on: {
      Increment: ({ state, target }) => target.full.counter(new Counter({ count: state.count + 1 })),
      Noop: ({ target }) => target.none()
    }
  }
})

const reentryMachine = Machine.make({
  states: NavigationStates.states,
  events: Machine.events(Restart),
  initial: () =>
    NavigationStates.initial.app(
      new App({}),
      (app) => app.one(new One({}))
    )
}).handle({
  app: {
    on: {
      Restart: {
        reenter: true,
        transition: ({ target }) => target.full.app(new App({}), (app) => app.one(new One({})))
      }
    }
  }
})

class Dashboard extends Schema.TaggedClass<Dashboard>("Dashboard")("Dashboard", {}) {}
class Left extends Schema.TaggedClass<Left>("Left")("Left", {}) {}
class Right extends Schema.TaggedClass<Right>("Right")("Right", {}) {}

const ParallelStates = Machine.defineStates({
  dashboard: {
    schema: Dashboard,
    type: "parallel",
    states: {
      left: Left,
      right: Right
    }
  }
})

const parallelMachine = Machine.make({
  states: ParallelStates.states,
  events: Machine.events(),
  initial: () =>
    ParallelStates.initial.dashboard(
      new Dashboard({}),
      (dashboard) => dashboard.left(new Left({})).right(new Right({}))
    )
}).handle({ dashboard: {} })

class Workspace extends Schema.TaggedClass<Workspace>("Workspace")("Workspace", {}) {}
class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {}) {}
class Editing extends Schema.TaggedClass<Editing>("Editing")("Editing", {
  revision: Schema.Int
}) {}
class Away extends Schema.TaggedClass<Away>("Away")("Away", {}) {}
class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {}

const HistoryStates = Machine.defineStates({
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
})

const historyMachine = Machine.make({
  states: HistoryStates.states,
  events: Machine.events(Leave),
  initial: () =>
    HistoryStates.initial.workspace(
      new Workspace({}),
      (workspace) =>
        workspace.editor(
          new Editor({}),
          (editor) => editor.editing(new Editing({ revision: 1 }))
        )
    )
}).handle({
  workspace: {
    history: {
      recent: {
        default: () =>
          HistoryStates.initial.workspace(
            new Workspace({}),
            (workspace) =>
              workspace.editor(
                new Editor({}),
                (editor) => editor.editing(new Editing({ revision: 0 }))
              )
          )
      },
      exact: {
        default: () =>
          HistoryStates.initial.workspace(
            new Workspace({}),
            (workspace) =>
              workspace.editor(
                new Editor({}),
                (editor) => editor.editing(new Editing({ revision: 0 }))
              )
          )
      }
    },
    on: {
      Leave: ({ target }) => target.full.away(new Away({}))
    },
    states: {
      editor: {
        initial: () => new Editing({ revision: 0 })
      }
    }
  }
})

const StructuralHistoryStates = Machine.defineStates({
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
})

const structuralHistoryInitial = () =>
  StructuralHistoryStates.initial.workspace.from((workspace) => workspace.editor.from((editor) => editor.idle.from()))

const structuralHistoryMachine = Machine.make({
  states: StructuralHistoryStates.states,
  events: Machine.events(Leave),
  initial: structuralHistoryInitial
}).handle({
  workspace: {
    history: {
      exact: { default: structuralHistoryInitial }
    },
    on: {
      Leave: ({ target }) => target.full.away.from()
    }
  }
})

class Finished extends Schema.TaggedClass<Finished>("Finished")("Finished", {}) {}

const CompletionStates = Machine.defineStates({
  finished: {
    schema: Finished,
    type: "final",
    output: Schema.String
  }
})

const completionMachine = Machine.make({
  states: CompletionStates.states,
  events: Machine.events(),
  initial: () => CompletionStates.initial.finished(new Finished({}))
}).handle({
  finished: {
    output: () => "complete"
  }
})

class Workflow extends Schema.TaggedClass<Workflow>("Workflow")("Workflow", {}) {}
class Archived extends Schema.TaggedClass<Archived>("Archived")("Archived", {}) {}

const DoneTransitionStates = Machine.defineStates({
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
})

const doneTransitionMachine = Machine.make({
  states: DoneTransitionStates.states,
  events: Machine.events(),
  initial: () =>
    DoneTransitionStates.initial.workflow(
      new Workflow({}),
      (workflow) => workflow.finished(new Finished({}))
    )
}).handle({
  workflow: {
    onDone: ({ target }) => target.full.archived(new Archived({})),
    states: {
      finished: {
        output: () => "workflow-output"
      }
    }
  }
})

const nestedCompletionMachine = Machine.make({
  states: DoneTransitionStates.states,
  events: Machine.events(),
  initial: () =>
    DoneTransitionStates.initial.workflow(
      new Workflow({}),
      (workflow) => workflow.finished(new Finished({}))
    )
}).handle({
  workflow: {
    states: {
      finished: {
        output: () => "nested-output"
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
        final: { ...trace.final, value: { _tag: "Invented" } }
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
      assert.strictEqual((updated.final.value as Counter).count, 1)
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
          states: { left: final.states.left }
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
          states: { left: final.states.left, right: final.states.left }
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
          state: { path: "workspace.missing", value: new Editing({ revision: 1 }) }
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
          state: { path: "workspace.recent", value: new Editing({ revision: 1 }) }
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

  it.effect("reports requested targets outside declared bounds", () =>
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
        laws: ["targetBounds"]
      }).pipe(Effect.flip)
      const violation = error.violations.find(({ law }) => law === "targetBounds.target")
      assert.strictEqual(violation?.eventIndex, 0)
      assert.strictEqual(violation?.microstepIndex, 0)
      assert.strictEqual(violation?.path, "off")
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
