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
      const states = Machine.state({
        states: {
          Ready: {
            schema: State.cases.Ready,
            states: {
              Idle: State.cases.Idle,
              SavingPlan: State.cases.SavingPlan
            }
          }
        }
      })
      let observedEntry: {
        readonly notice: string | null
        readonly request: string
      } | undefined
      const targets1 = Machine.targets(states)
      const machine = Machine.make({
        branches: {
          transition1: { destination: { target: targets1.root.Ready.SavingPlan, update: targets1.root.Ready } },
          transition2: { destination: { target: targets1.root.Ready.SavingPlan, update: targets1.root.Ready } }
        },
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.Ready,
          data: { notice: "Previous notice" }
        },
        states: {
          Ready: {
            initial: {
              target: Machine.targets(states).root.Ready.Idle
            },
            states: {
              Idle: {
                on: {
                  CreatePlan: {
                    branches: "transition1",
                    resolve: ({ ancestors: { Ready: current }, event, select: { destination: target } }) =>
                      target.from({ request: event.input }).update.decoded(
                        State.cases.Ready.make({ ...current, notice: null })
                      )
                  },
                  InvalidPlan: {
                    branches: "transition2",
                    resolve: ({ select: { destination: target } }) =>
                      target.from({ request: "invalid" }).update.from({ notice: 1 } as any)
                  }
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
        }
      })
      assert.deepStrictEqual(Machine.transitionDefinitions(machine)[0]?.branches, [{
        type: "branch",
        key: "destination",
        title: "destination",
        target: "Ready.SavingPlan",
        selection: { kind: "state", scope: "branch", path: "Ready.SavingPlan" },
        updates: ["Ready"]
      }])
      const initial = yield* Machine.planInitial(machine)
      const invalid = yield* Machine.plan(machine, initial.state, Event.cases.InvalidPlan.make({})).pipe(Effect.flip)
      assert.instanceOf(invalid, Machine.MachineSchemaDecodeError)
      assert.strictEqual(invalid.state, "Ready")
      assert.strictEqual(observedEntry, undefined)
      const planned = yield* Machine.plan(machine, initial.state, Event.cases.CreatePlan.make({ input: "New plan" }))
      assert.deepStrictEqual(planned.next.state, {
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
      const states = Machine.state({
        states: {
          Ready: {
            schema: State.cases.Ready,
            states: {
              Idle: {},
              Saving: State.cases.Saving
            }
          }
        }
      })
      let idleSawDay: string | undefined
      const targets2 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets2.root.Ready.Idle, update: targets2.root.Ready } } },
        effects: { source1: Effect.suspend(() => Effect.succeed("Monday")) },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.Ready,
          data: { day: "Sunday", notice: "Saving" }
        },
        states: {
          Ready: {
            initial: {
              target: Machine.targets(states).root.Ready.Saving,
              data: { request: "change" }
            },
            states: {
              Idle: {
                entry: ({ ancestors }) => {
                  idleSawDay = ancestors.Ready.day
                  return undefined
                }
              },
              Saving: {
                invoke: {
                  src: "source1",
                  id: "save",
                  onDone: {
                    branches: "transition1",
                    resolve: ({ ancestors: { Ready: current }, output, select: { destination: target } }) =>
                      target.from().update.decoded(State.cases.Ready.make({ ...current, day: output, notice: "Saved" }))
                  }
                }
              }
            }
          }
        }
      })
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      const snapshot = yield* ref.state
      assert.strictEqual(snapshot.state.path, "Ready")
      if (snapshot.state.path !== "Ready") {
        throw new Error("expected Ready")
      }
      assert.strictEqual(snapshot.state.value.day, "Monday")
      assert.strictEqual(snapshot.state.value.notice, "Saved")
      assert.strictEqual(snapshot.state.state.path, "Ready.Idle")
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
      const states = Machine.state({
        states: {
          session: {
            schema: State.cases.Session,
            states: {
              editing: {
                schema: State.cases.Editing,
                states: { idle: State.cases.Idle }
              }
            }
          }
        }
      })
      const targets3 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.session,
          data: { count: 0 }
        },
        states: {
          session: {
            initial: {
              target: Machine.targets(states).root.session.editing,
              data: { draft: "kept" }
            },
            states: {
              editing: {
                initial: {
                  target: Machine.targets(states).root.session.editing.idle
                },
                states: {
                  idle: {
                    on: {
                      Increment: {
                        update: targets3.root.session,
                        data: ({ ancestors: { session: current } }) => ({ count: current.count + 1 })
                      }
                    }
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
      assert.deepStrictEqual(planned.next.state, {
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
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      const targets4 = Machine.targets(states)
      const machine = Machine.make({
        branches: {
          transition1: { changed: { update: targets4.root.scope, title: "Value changed" }, unchanged: { none: true } }
        },
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
            states: {
              idle: {
                on: {
                  Set: {
                    branches: "transition1",
                    resolve: ({ event, select }) =>
                      event.changed ? select.changed.from({ count: 1 }) : select.unchanged()
                  }
                }
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
        selection: { kind: "update", scope: "branch", path: "scope" },
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
      assert.strictEqual(changed.next.state.value.count, 1)
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
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      const targets5 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
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
                  Quiet: {
                    update: targets5.root.scope,
                    data: ({ ancestors: { scope: current } }) => ({ count: current.count + 1 })
                  },
                  Loud: {
                    update: targets5.root.scope,
                    reenter: true,
                    data: ({ ancestors: { scope: current } }) => ({ count: current.count + 1 })
                  }
                }
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
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      const targets6 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { update: targets6.root.scope } } },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
            states: {
              idle: {
                always: {
                  branches: "transition1",
                  resolve: ({ ancestors: { scope: current }, decline, select: { destination: owner } }) =>
                    current.count < 2
                      ? owner.from({ count: current.count + 1 })
                      : decline(),
                  declinable: true
                }
              }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      assert.strictEqual(initial.state.state.value.count, 2)
      assert.strictEqual(initial.microsteps.length, 2)
      assert.deepStrictEqual(initial.microsteps.map((step) => step.changed), [false, false])
    }))
  it.effect("preserves history records while replacing the history owner's value", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Root: { count: Schema.Number }, A: {}, Outside: {} })
      const Event = Schema.TaggedUnion({ Leave: {}, Return: {}, Update: {} })
      const states = Machine.state({
        states: {
          root: {
            schema: State.cases.Root,
            states: {
              a: State.cases.A,
              recent: { type: "history", history: "deep" }
            }
          },
          outside: State.cases.Outside
        }
      })
      const initialRoot = () => ({
        path: "" as const,
        value: undefined,
        state: {
          path: "root" as const,
          value: State.cases.Root.make({ count: 0 }),
          state: { path: "root.a" as const, value: State.cases.A.make({}) }
        }
      })
      const targets7 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition3: { destination: { history: targets7.root.root.recent } } },
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.root,
          decoded: true,
          data: State.cases.Root.make({ count: 0 })
        },
        states: {
          root: {
            initial: {
              target: Machine.targets(states).root.root.a,
              decoded: true,
              data: State.cases.A.make({})
            },
            history: { recent: { default: initialRoot } },
            states: {
              a: {
                on: {
                  Leave: { target: targets7.root.outside },
                  Update: {
                    update: targets7.root.root,
                    data: ({ ancestors: { root: current } }) => ({ count: current.count + 1 })
                  }
                }
              }
            }
          },
          outside: {
            on: {
              Return: { branches: "transition3", resolve: ({ select: { destination: target } }) => target() }
            }
          }
        }
      })
      const initial = yield* Machine.planInitial(machine)
      const outside = yield* Machine.plan(machine, initial.state, Event.cases.Leave.make({}))
      const restored = yield* Machine.plan(machine, outside.next, Event.cases.Return.make({}))
      const historyBefore = restored.next.history
      const updated = yield* Machine.plan(machine, restored.next, Event.cases.Update.make({}))
      assert.deepStrictEqual(updated.next.history, historyBefore)
      if (updated.next.state.path !== "root") {
        throw new Error("expected restored root")
      }
      assert.strictEqual(updated.next.state.value.count, 1)
      assert.strictEqual(updated.next.state.state.path, "root.a")
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
      const states = Machine.state({
        states: {
          root: {
            schema: State.cases.Root,
            type: "parallel",
            states: {
              left: {
                schema: State.cases.Left,
                states: {
                  done: { schema: State.cases.Done, type: "final", output: Schema.String }
                }
              },
              right: {
                schema: State.cases.Right,
                states: { idle: State.cases.Idle }
              }
            }
          }
        }
      })
      let completions = 0
      const targets8 = Machine.targets(states)
      const machine = Machine.make({
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.root,
          data: { revision: 0 }
        },
        states: {
          root: {
            states: {
              left: {
                initial: {
                  target: Machine.targets(states).root.root.left.done
                },
                onDone: {
                  none: true,
                  resolve: () => {
                    completions += 1
                    return undefined
                  }
                },
                states: {
                  done: { output: () => "complete" }
                }
              },
              right: {
                initial: {
                  target: Machine.targets(states).root.root.right.idle
                },
                states: {
                  idle: {
                    on: {
                      Update: {
                        update: targets8.root.root,
                        data: ({ ancestors: { root: current } }) => ({ revision: current.revision + 1 })
                      }
                    }
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
      assert.strictEqual(updated.next.state.value.revision, 1)
    }))
  it.effect("reports update construction failures through the state schema boundary", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Break: {} })
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      const targets9 = Machine.targets(states)
      const machine = Machine.make({
        id: "state-update-schema",
        root: states,
        events: Machine.eventsFromSchemas(Event)
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
            states: {
              idle: {
                on: {
                  Break: { update: targets9.root.scope, data: () => ({ count: "bad" } as any) }
                }
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
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      let starts = 0
      const targets10 = Machine.targets(states)
      const machine = Machine.make({
        effects: { source1: Effect.suspend(() => Effect.sync(() => ++starts)) },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
            states: {
              idle: {
                invoke: {
                  src: "source1",
                  id: "load",
                  onDone: { update: targets10.root.scope, data: ({ output }) => ({ count: output }) }
                }
              }
            }
          }
        }
      })
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      assert.strictEqual((yield* ref.state).state.value.count, 1)
      assert.strictEqual(starts, 1)
      yield* ref.stop
    }))
  it.effect("retains commands, raised events, and emitted events", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({ Scope: { count: Schema.Number }, Idle: {} })
      const Event = Schema.TaggedUnion({ Update: {}, Raised: {} })
      const Emission = Schema.TaggedUnion({ Changed: { count: Schema.Number } })
      const Events = Machine.eventsFromSchemas(Event)
      const Emissions = Machine.emittedEventsFromSchemas(Emission)
      const states = Machine.state({
        states: {
          scope: {
            schema: State.cases.Scope,
            states: { idle: State.cases.Idle }
          }
        }
      })
      const targets11 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { update: targets11.root.scope } } },
        root: states,
        events: Events,
        emittedEvents: Emissions
      }).handle({
        initial: {
          target: Machine.targets(states).root.scope,
          data: { count: 0 }
        },
        states: {
          scope: {
            initial: {
              target: Machine.targets(states).root.scope.idle
            },
            states: {
              idle: {
                on: {
                  Update: {
                    branches: "transition1",
                    resolve: ({ self, select: { destination: owner } }, enqueue) => {
                      enqueue.raise(Events.Raised())
                      enqueue.emit(Emissions.Changed({ count: 1 }))
                      enqueue.sendTo(self, Events.Raised())
                      return owner.from({ count: 1 })
                    }
                  },
                  Raised: { none: true }
                }
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
      assert.strictEqual(planned.next.state.value.count, 1)
    }))
})
