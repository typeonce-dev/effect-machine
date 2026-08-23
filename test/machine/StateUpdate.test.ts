import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
import { MachineTest } from "../../src/testing/index.js"

describe("state value updates", () => {
  it.effect("changes topology and one retained owner atomically", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Ready: { notice: Schema.NullOr(Schema.String) },
        Idle: {},
        SavingPlan: { request: Schema.String }
      })
      const Event = Schema.TaggedUnion({ CreatePlan: { input: Schema.String }, InvalidPlan: {} })
      const states = Machine.states({
        Ready: {
          schema: State.cases.Ready,
          initial: "Idle",
          states: {
            Idle: State.cases.Idle,
            SavingPlan: State.cases.SavingPlan
          }
        }
      })
      let observedEntry: { readonly notice: string | null; readonly request: string } | undefined
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.Ready.initial.resolve(({ target }) =>
            target.from({ notice: "Previous notice" }, (ready) => ready.Idle.from())
          )
      }).handle({
        Ready: {
          states: {
            Idle: {
              on: {
                CreatePlan: (to) =>
                  to.local.SavingPlan()
                    .updating(to.branch.Ready)
                    .resolve(({ current, event, owner, target }) =>
                      target.from({ request: event.input }).update(
                        owner.decoded(State.cases.Ready.make({ ...current, notice: null }))
                      )
                    ),
                InvalidPlan: (to) =>
                  to.local.SavingPlan()
                    .updating(to.branch.Ready)
                    .resolve(({ owner, target }) =>
                      target.from({ request: "invalid" }).update(
                        owner.from({ notice: 1 } as any)
                      )
                    )
              }
            },
            SavingPlan: {
              entry: ({ ancestors, state }) => {
                observedEntry = { notice: ancestors.Ready.notice, request: state.request }
                return undefined
              }
            }
          }
        }
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine)[0]?.branches, [{
        type: "direct",
        target: "Ready.SavingPlan",
        selection: { kind: "state", scope: "local", path: "Ready.SavingPlan" },
        updates: ["Ready"]
      }])

      const initial = yield* Machine.planInitial(machine)
      const invalid = yield* Machine.plan(machine, initial.state, Event.cases.InvalidPlan.make({})).pipe(Effect.flip)
      assert.instanceOf(invalid, Machine.MachineSchemaDecodeError)
      assert.strictEqual(invalid.state, "Ready")
      assert.strictEqual(observedEntry, undefined)

      const planned = yield* Machine.plan(machine, initial.state, Event.cases.CreatePlan.make({ input: "New plan" }))

      assert.deepStrictEqual(planned.next, {
        path: "Ready",
        value: State.cases.Ready.make({ notice: null }),
        state: {
          path: "Ready.SavingPlan",
          value: State.cases.SavingPlan.make({ request: "New plan" })
        }
      })
      assert.deepStrictEqual(observedEntry, { notice: null, request: "New plan" })
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, ["Ready.Idle"])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, ["Ready.SavingPlan"])
      assert.deepStrictEqual(planned.microsteps[0]?.transitions[0]?.updates, ["Ready"])

      const trace = yield* MachineTest.run(machine, { events: [Event.cases.CreatePlan.make({ input: "New plan" })] })
      yield* MachineTest.verify(machine, trace)
      assert.strictEqual(MachineTest.coverage(machine, trace).microsteps.updates, 1)
    }))

  it.effect("combines invocation completion with a schema-less destination", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Ready: { day: Schema.String, notice: Schema.String },
        Saving: { request: Schema.String }
      })
      const states = Machine.states({
        Ready: {
          schema: State.cases.Ready,
          initial: "Saving",
          states: {
            Idle: {},
            Saving: State.cases.Saving
          }
        }
      })
      let idleSawDay: string | undefined
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.Ready.initial.resolve(({ target }) =>
            target.from(
              { day: "Sunday", notice: "Saving" },
              (ready) => ready.Saving.from({ request: "change" })
            )
          )
      }).handle({
        Ready: {
          states: {
            Idle: {
              entry: ({ ancestors }) => {
                idleSawDay = ancestors.Ready.day
                return undefined
              }
            },
            Saving: {
              invoke: (from) =>
                from.effect("save", () => Effect.succeed("Monday")).onDone((to) =>
                  to.local.Idle()
                    .updating(to.branch.Ready)
                    .resolve(({ current, output, owner, target }) =>
                      target.from().update(
                        owner.decoded(State.cases.Ready.make({ ...current, day: output, notice: "Saved" }))
                      )
                    )
                )
            }
          }
        }
      })

      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow
      const snapshot = yield* ref.state
      assert.strictEqual(snapshot.path, "Ready")
      if (snapshot.path !== "Ready") throw new Error("expected Ready")
      assert.strictEqual(snapshot.value.day, "Monday")
      assert.strictEqual(snapshot.value.notice, "Saved")
      assert.strictEqual(snapshot.state.path, "Ready.Idle")
      assert.strictEqual(idleSawDay, "Monday")
      yield* ref.stop
    }))

  it.effect("updates the local owner without changing its active descendants", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Session: { count: Schema.Number },
        Editing: { draft: Schema.String },
        Idle: {}
      })
      const Event = Schema.TaggedUnion({ Increment: {} })
      const states = Machine.states({
        session: {
          schema: State.cases.Session,
          initial: "editing",
          states: {
            editing: {
              schema: State.cases.Editing,
              initial: "idle",
              states: { idle: State.cases.Idle }
            }
          }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.session.initial.resolve(({ target }) =>
            target.from({ count: 0 }, (session) =>
              session.editing.from({ draft: "kept" }, (editing) => editing.idle.from()))
          )
      }).handle({
        session: {
          states: {
            editing: {
              states: {
                idle: {
                  on: {
                    Increment: (to) =>
                      to.branch.session.update(({ current, owner }) =>
                        owner.from({ count: current.count + 1 })
                      )
                  }
                }
              }
            }
          }
        }
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "session.editing.idle",
        trigger: { type: "event", event: "Increment" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: undefined,
          selection: { kind: "update", scope: "branch", path: "session" },
          updates: ["session"]
        }]
      }])

      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, Event.cases.Increment.make({}))

      assert.deepStrictEqual(planned.next, {
        path: "session",
        value: State.cases.Session.make({ count: 1 }),
        state: {
          path: "session.editing",
          value: State.cases.Editing.make({ draft: "kept" }),
          state: { path: "session.editing.idle", value: State.cases.Idle.make({}) }
        }
      })
      assert.deepStrictEqual(planned.microsteps[0]?.transitions, [{
        source: "session.editing.idle",
        trigger: { type: "event", event: "Increment" },
        reenter: false,
        branchIndex: 0,
        branchKey: undefined,
        target: undefined,
        resolvedTarget: undefined,
        updates: ["session"]
      }])
      assert.deepStrictEqual(planned.microsteps[0]?.exitPaths, [])
      assert.deepStrictEqual(planned.microsteps[0]?.entryPaths, [])
      assert.isFalse(planned.microsteps[0]?.changed)

      const trace = yield* MachineTest.run(machine, { events: [Event.cases.Increment.make({})] })
      yield* MachineTest.verify(machine, trace)
      const coverage = MachineTest.coverage(machine, trace)
      assert.strictEqual(coverage.microsteps.updates, 1)
      assert.strictEqual(coverage.microsteps.targetless, 0)
    }))

  it.effect("selects updates as named branches without turning them into topology targets", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Set: { changed: Schema.Boolean } })
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          states: {
            idle: {
              on: {
                Set: (to) =>
                  to.branches({
                    changed: { target: to.local.update, title: "Value changed" },
                    unchanged: { target: to.none }
                  }).resolve(({ event, select }) =>
                    event.changed ? select.changed.from({ count: 1 }) : select.unchanged()
                  )
              }
            }
          }
        }
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine)[0]?.branches, [{
        type: "branch",
        key: "changed",
        title: "Value changed",
        target: undefined,
        selection: { kind: "update", scope: "local", path: "scope" },
        updates: ["scope"]
      }, {
        type: "branch",
        key: "unchanged",
        title: "unchanged",
        target: undefined,
        selection: { kind: "none", scope: "local", path: undefined },
        updates: []
      }])

      const initial = yield* Machine.planInitial(machine)
      const changed = yield* Machine.plan(machine, initial.state, Event.cases.Set.make({ changed: true }))
      assert.strictEqual(changed.next.value.count, 1)
      assert.strictEqual(changed.microsteps[0]?.transitions[0]?.branchKey, "changed")

      const unchanged = yield* Machine.plan(machine, initial.state, Event.cases.Set.make({ changed: false }))
      assert.deepStrictEqual(unchanged.next, initial.state)
      assert.strictEqual(unchanged.microsteps[0]?.transitions[0]?.branchKey, "unchanged")
    }))

  it.effect("reenters the handler source, not the updated owner", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Quiet: {}, Loud: {} })
      const lifecycle: Array<string> = []
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          entry: () => {
            lifecycle.push("enter scope")
            return undefined
          },
          exit: () => {
            lifecycle.push("exit scope")
            return undefined
          },
          states: {
            idle: {
              entry: () => {
                lifecycle.push("enter idle")
                return undefined
              },
              exit: () => {
                lifecycle.push("exit idle")
                return undefined
              },
              on: {
                Quiet: (to) => to.local.update(({ current, owner }) => owner.from({ count: current.count + 1 })),
                Loud: (to) =>
                  to.local.update(
                    ({ current, owner }) => owner.from({ count: current.count + 1 }),
                    { reenter: true }
                  )
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      lifecycle.length = 0
      const quiet = yield* Machine.plan(machine, initial.state, Event.cases.Quiet.make({}))
      assert.deepStrictEqual(lifecycle, [])
      assert.deepStrictEqual(quiet.microsteps[0]?.exitPaths, [])
      assert.deepStrictEqual(quiet.microsteps[0]?.entryPaths, [])

      const loud = yield* Machine.plan(machine, quiet.next, Event.cases.Loud.make({}))
      assert.deepStrictEqual(lifecycle, ["exit idle", "enter idle"])
      assert.deepStrictEqual(loud.microsteps[0]?.exitPaths, ["scope.idle"])
      assert.deepStrictEqual(loud.microsteps[0]?.entryPaths, ["scope.idle"])
    }))

  it.effect("runs eventless stabilization again after an update", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          states: {
            idle: {
              always: (to) =>
                to.local.update(({ current, decline, owner }) =>
                  current.count < 2
                    ? owner.from({ count: current.count + 1 })
                    : decline(), { declinable: true })
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      assert.strictEqual(initial.state.value.count, 2)
      assert.strictEqual(initial.microsteps.length, 2)
      assert.deepStrictEqual(initial.microsteps.map((step) => step.changed), [false, false])
    }))

  it.effect("preserves history records while replacing the history owner's value", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Root: { count: Schema.Number }, A: {}, Outside: {} })
      const Event = Schema.TaggedUnion({ Leave: {}, Return: {}, Update: {} })
      const states = Machine.states({
        root: {
          schema: State.cases.Root,
          initial: "a",
          states: {
            a: State.cases.A,
            recent: { type: "history", history: "deep" }
          }
        },
        outside: State.cases.Outside
      })
      const initialRoot = () => ({
        path: "root" as const,
        value: State.cases.Root.make({ count: 0 }),
        state: { path: "root.a" as const, value: State.cases.A.make({}) }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) => to.root.initial.resolve(() => initialRoot())
      }).handle({
        root: {
          history: { recent: { default: initialRoot } },
          states: {
            a: {
              on: {
                Leave: (to) => to.full.outside().resolve(({ target }) => target.from()),
                Update: (to) => to.local.update(({ current, owner }) => owner.from({ count: current.count + 1 }))
              }
            }
          }
        },
        outside: {
          on: {
            Return: (to) => to.history.root.recent.resolve(({ target }) => target())
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const outside = yield* Machine.plan(machine, initial.state, Event.cases.Leave.make({}))
      const restored = yield* Machine.plan(machine, outside.next, Event.cases.Return.make({}))
      const historyBefore = restored.next.history
      const updated = yield* Machine.plan(machine, restored.next, Event.cases.Update.make({}))

      assert.deepStrictEqual(updated.next.history, historyBefore)
      if (updated.next.path !== "root") throw new Error("expected restored root")
      assert.strictEqual(updated.next.value.count, 1)
      assert.strictEqual(updated.next.state.path, "root.a")
    }))

  it.effect("preserves completion outputs and does not replay completion", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Root: { revision: Schema.Number },
        Left: {},
        Done: {},
        Right: {},
        Idle: {}
      })
      const Event = Schema.TaggedUnion({ Update: {} })
      const states = Machine.states({
        root: {
          schema: State.cases.Root,
          type: "parallel",
          states: {
            left: {
              schema: State.cases.Left,
              initial: "done",
              states: {
                done: { schema: State.cases.Done, type: "final", output: Schema.String }
              }
            },
            right: {
              schema: State.cases.Right,
              initial: "idle",
              states: { idle: State.cases.Idle }
            }
          }
        }
      })
      let completions = 0
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.root.initial.resolve(({ target }) =>
            target.from({ revision: 0 }, (root) =>
              root.left.from((left) => left.done.from())
                .right.from((right) => right.idle.from()))
          )
      }).handle({
        root: {
          states: {
            left: {
              onDone: (to) =>
                to.none.resolve(() => {
                  completions += 1
                  return undefined
                }),
              states: { done: { output: () => "complete" } }
            },
            right: {
              states: {
                idle: {
                  on: {
                    Update: (to) =>
                      to.branch.root.update(({ current, owner }) => owner.from({ revision: current.revision + 1 }))
                  }
                }
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const completedBefore = initial.state.completed
      const completionCount = completions
      const updated = yield* Machine.plan(machine, initial.state, Event.cases.Update.make({}))

      assert.deepStrictEqual(updated.next.completed, completedBefore)
      assert.strictEqual(completions, completionCount)
      assert.strictEqual(updated.next.value.revision, 1)
    }))

  it.effect("reports update construction failures through the state schema boundary", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Break: {} })
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      const machine = Machine.make({
        id: "state-update-schema",
        states: states.states,
        events: Machine.events(Event),
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          states: {
            idle: {
              on: {
                Break: (to) => to.local.update(({ owner }) => owner.from({ count: "bad" } as any))
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const error = yield* Machine.plan(machine, initial.state, Event.cases.Break.make({})).pipe(Effect.flip)
      assert.instanceOf(error, Machine.MachineSchemaDecodeError)
      assert.strictEqual(error.boundary, "state")
      assert.strictEqual(error.state, "scope")
    }))

  it.effect("updates from an invocation outcome without restarting the source", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      let starts = 0
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          states: {
            idle: {
              invoke: (from) =>
                from.effect("load", () => Effect.sync(() => ++starts)).onDone((to) =>
                  to.local.update(({ output, owner }) => owner.from({ count: output }))
                )
            }
          }
        }
      })

      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow

      assert.strictEqual((yield* ref.state).value.count, 1)
      assert.strictEqual(starts, 1)
      yield* ref.stop
    }))

  it.effect("retains commands, raised events, and emitted events", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Update: {}, Raised: {} })
      const Emission = Schema.TaggedUnion({ Changed: { count: Schema.Number } })
      const Events = Machine.events(Event)
      const Emissions = Machine.emittedEvents(Emission)
      const states = Machine.states({
        scope: {
          schema: State.cases.Scope,
          initial: "idle",
          states: { idle: State.cases.Idle }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Events,
        emittedEvents: Emissions,
        initial: (to) =>
          to.scope.initial.resolve(({ target }) => target.from({ count: 0 }, (scope) => scope.idle.from()))
      }).handle({
        scope: {
          states: {
            idle: {
              on: {
                Update: (to) =>
                  to.local.update(({ self, owner }, enqueue) => {
                    enqueue.raise(Events.Raised())
                    enqueue.emit(Emissions.Changed({ count: 1 }))
                    enqueue.sendTo(self, Events.Raised())
                    return owner.from({ count: 1 })
                  }),
                Raised: (to) => to.none
              }
            }
          }
        }
      })

      const initial = yield* Machine.planInitial(machine)
      const planned = yield* Machine.plan(machine, initial.state, Events.Update())

      assert.strictEqual(planned.commands.length, 1)
      assert.deepStrictEqual(planned.emittedEvents, [Emission.cases.Changed.make({ count: 1 })])
      assert.deepStrictEqual(planned.microsteps.map(({ event }) => event._tag), ["Update", "Raised"])
      assert.strictEqual(planned.next.value.count, 1)
    }))
})
