import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("root input construction", () => {
  it("requires fresh typed input only when initializing root", () => {
    const root = Machine.state({
      states: {
        Loading: { fields: { request: Schema.String }, states: { Busy: {} } },
        Idle: {}
      }
    })
    const definition = Machine.make({
      root,
      input: Schema.Struct({ request: Schema.String }),
      events: Machine.events({ Reload: { request: Schema.String }, Branch: {} }),
      branches: { reset: { root: { initialize: true } } }
    })
    const machine = definition.handle({
      initial: {
        target: "Loading",
        data: ({ input }) => {
          expect(input).type.toBe<{ readonly request: string }>()
          return { request: input.request }
        }
      },
      on: {
        Reload: { initialize: ({ event }) => ({ request: event.request }) },
        Branch: {
          branches: "reset",
          resolve: ({ select }) => {
            expect(select.root).type.not.toBeCallableWith()
            expect(select.root).type.not.toBeCallableWith({ data: { request: "a" } })
            expect(select.root).type.not.toBeCallableWith({ input: { request: 1 } })
            expect(select.root).type.not.toBeCallableWith({ input: () => ({ request: "a" }) })
            return select.root({ input: { request: "a" } })
          }
        }
      },
      states: {
        Loading: {
          initial: { target: "Loading.Busy" },
          on: {
            Reload: { target: "Loading", data: ({ event }) => ({ request: event.request }) }
          }
        }
      }
    })
    expect(Machine.planInitial(machine, { request: "a" })).type.not.toBe<never>()
    const initial = { target: "Idle" as const }
    const states = { Loading: { initial: { target: "Loading.Busy" as const } } }
    expect(definition.handle).type.not.toBeCallableWith({ initial, states, on: { Reload: { initialize: true } } })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { initialize: { request: 1 } } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { initialize: { request: "a" }, data: {} } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { target: "Idle", input: { request: "a" } } }
    })
    expect(definition.handle).type.not.toBeCallableWith({ initial, states, on: { Reload: { target: "root" } } })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { initialize: { request: "a" }, target: "Idle" } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { initialize: { request: "a" }, update: "root" } }
    })
    expect(definition.handle).type.toBeCallableWith({
      initial,
      states,
      on: { Reload: { initialize: { request: "a" }, guard: () => true, reenter: true } }
    })
  })
})
