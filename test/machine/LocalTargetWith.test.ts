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
      const states = Machine.states({
        search: {
          schema: State.cases.Search,
          initial: "Idle",
          states: {
            Idle: {},
            Updated: {}
          }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(Events),
        initial: (to) =>
          to.search.initial.resolve(({ target }) => target.from({ query: "" }, (search) => search.Idle.from()))
      }).handle({
        search: {
          on: {
            UpdateQuery: (to) =>
              to.local.with.resolve(
                ({ event, target }) => target.from({ query: event.query }, (search) => search.Updated.from()),
                { reenter: true }
              )
          },
          states: {
            Idle: {},
            Updated: {
              on: {
                Reset: (to) => to.local.Idle().resolve(({ target }) => target.from())
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
          type: "direct",
          target: "search",
          selection: { path: "search", kind: "state", scope: "local" }
        }]
      }, {
        source: "search.Updated",
        trigger: { type: "event", event: "Reset" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "search.Idle",
          selection: { path: "search.Idle", kind: "state", scope: "local" }
        }]
      }])

      const initial = yield* Machine.planInitial(machine)
      const updated = yield* Machine.plan(machine, initial.state, Events.cases.UpdateQuery.make({ query: "next" }))

      assert.deepStrictEqual(updated.next, {
        path: "search",
        value: State.cases.Search.make({ query: "next" }),
        state: {
          path: "search.Updated",
          value: undefined
        }
      })

      const reset = yield* Machine.plan(machine, updated.next, Events.cases.Reset.make({}))
      assert.deepStrictEqual(reset.next, {
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
      const states = Machine.states({
        search: {
          schema: State.cases.Search,
          initial: "Searching",
          states: {
            Searching: {},
            Updated: {}
          }
        }
      })
      const machine = Machine.make({
        states: states.states,
        events: Machine.events(),
        initial: (to) =>
          to.search.initial.resolve(({ target }) =>
            target.from({ query: "pending" }, (search) => search.Searching.from())
          )
      }).handle({
        search: {
          states: {
            Searching: {
              invoke: (from) =>
                from.effect("search", () => Effect.succeed("resolved")).onDone((to) =>
                  to.local.with.resolve(({ output, target }) =>
                    target.from({ query: output }, (search) => search.Updated.from())
                  )
                )
            },
            Updated: {}
          }
        }
      })

      assert.deepStrictEqual(Machine.transitionDefinitions(machine), [{
        source: "search.Searching",
        trigger: { type: "invoke", id: "search", outcome: "done" },
        reenter: false,
        acceptance: "required",
        branches: [{
          type: "direct",
          target: "search",
          selection: { path: "search", kind: "state", scope: "local" }
        }]
      }])

      const ref = yield* Machine.start(machine)
      for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow

      assert.deepStrictEqual(yield* ref.state, {
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
    const states = Machine.states({
      flow: {
        initial: "Idle",
        states: {
          Idle: {},
          Updated: {}
        }
      }
    })

    Machine.make({
      states: states.states,
      events: Machine.events(Event),
      initial: (to) => to.flow.initial.resolve(({ target }) => target.from((flow) => flow.Idle.from()))
    }).handle({
      flow: {
        states: {
          Idle: {
            on: {
              Advance: (to) => {
                assert.notProperty(to.local, "with")
                return to.local.Updated().resolve(({ target }) => target.from())
              }
            }
          },
          Updated: {}
        }
      }
    })
  })
})
