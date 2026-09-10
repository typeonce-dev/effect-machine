import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Machine } from "../../src/index.js"
describe("local compound target selection", () => {
  it.effect("captures and plans local.with from the compound scope", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Search: { query: Schema.String },
        Idle: {},
        Updated: {}
      })
      const Events = Schema.TaggedUnion({
        UpdateQuery: { query: Schema.String },
        Reset: {}
      })
      const states = Machine.state({
        states: {
          search: {
            schema: State.cases.Search,
            states: {
              Idle: {},
              Updated: {}
            }
          }
        }
      })
      const targets1 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets1.root.search } } },
        root: states,
        events: Machine.eventsFromSchemas(Events)
      }).handle({
        initial: {
          target: Machine.targets(states).root.search,
          data: { query: "" }
        },
        states: {
          search: {
            initial: {
              target: Machine.targets(states).root.search.Idle
            },
            on: {
              UpdateQuery: {
                branches: "transition1",
                reenter: true,
                resolve: ({ event, select: { destination: target } }) =>
                  target({ data: { query: event.query }, states: { Updated: {} } })
              }
            },
            states: {
              Idle: {},
              Updated: {
                on: {
                  Reset: { target: targets1.root.search.Idle }
                }
              }
            }
          }
        }
      })
      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "search",
        trigger: { type: "event", event: "UpdateQuery" },
        reenter: true,
        acceptance: "required",
        branches: [{
          type: "branch",
          key: "destination",
          title: "destination",
          target: "search",
          selection: { path: "search", kind: "state", scope: "branch" },
          updates: []
        }]
      }, {
        source: "search.Updated",
        trigger: { type: "event", event: "Reset" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "search.Idle",
          selection: { path: "search.Idle", kind: "state", scope: "branch" },
          updates: []
        }]
      }])
      const initial = yield* Machine.planInitial(machine)
      const updated = yield* Machine.plan(machine, initial.state, Events.cases.UpdateQuery.make({ query: "next" }))
      assert.deepStrictEqual(updated.next.state, {
        path: "search",
        value: State.cases.Search.make({ query: "next" }),
        state: {
          path: "search.Updated",
          value: undefined
        }
      })
      const reset = yield* Machine.plan(machine, updated.next, Events.cases.Reset.make({}))
      assert.deepStrictEqual(reset.next.state, {
        path: "search",
        value: State.cases.Search.make({ query: "next" }),
        state: {
          path: "search.Idle",
          value: undefined
        }
      })
    }))
  it.effect("resolves local.with from a descendant invoke source", () =>
    Effect.gen(function*() {
      const State = Schema.TaggedUnion({
        Search: { query: Schema.String },
        Searching: {},
        Updated: {}
      })
      const states = Machine.state({
        states: {
          search: {
            schema: State.cases.Search,
            states: {
              Searching: {},
              Updated: {}
            }
          }
        }
      })
      const targets2 = Machine.targets(states)
      const machine = Machine.make({
        branches: { transition1: { destination: { target: targets2.root.search } } },
        effects: { source1: Effect.suspend(() => Effect.succeed("resolved")) },
        root: states,
        events: Machine.eventsFromSchemas()
      }).handle({
        initial: {
          target: Machine.targets(states).root.search,
          data: { query: "pending" }
        },
        states: {
          search: {
            initial: {
              target: Machine.targets(states).root.search.Searching
            },
            states: {
              Searching: {
                invoke: {
                  src: "source1",
                  id: "search",
                  onDone: {
                    branches: "transition1",
                    resolve: ({ output, select: { destination: target } }) =>
                      target({ data: { query: output }, states: { Updated: {} } })
                  }
                }
              },
              Updated: {}
            }
          }
        }
      })
      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "search.Searching",
        trigger: { type: "invoke", id: "search", outcome: "done" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "branch",
          key: "destination",
          title: "destination",
          target: "search",
          selection: { path: "search", kind: "state", scope: "branch" },
          updates: []
        }]
      }])
      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow
      }
      assert.deepStrictEqual((yield* ref.state).state, {
        path: "search",
        value: State.cases.Search.make({ query: "resolved" }),
        state: {
          path: "search.Updated",
          value: undefined
        }
      })
    }))
  it("does not install local.with for a schema-less compound scope", () => {
    const Event = Schema.TaggedUnion({ Advance: {} })
    const states = Machine.state({
      states: {
        flow: {
          states: {
            Idle: {},
            Updated: {}
          }
        }
      }
    })
    const targets3 = Machine.targets(states)
    assert.notProperty(targets3.root.flow, "with")
    Machine.make({
      root: states,
      events: Machine.eventsFromSchemas(Event)
    }).handle({
      initial: {
        target: Machine.targets(states).root.flow
      },
      states: {
        flow: {
          initial: {
            target: Machine.targets(states).root.flow.Idle
          },
          states: {
            Idle: {
              on: {
                Advance: { target: targets3.root.flow.Updated }
              }
            },
            Updated: {}
          }
        }
      }
    })
  })
})
