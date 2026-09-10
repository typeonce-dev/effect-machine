import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("root input construction", () => {
  it("requires fresh typed input only when targeting root", () => {
    const root = Machine.state({
      states: {
        Loading: { fields: { request: Schema.String }, states: { Busy: {} } },
        Idle: {}
      }
    })
    const targets = Machine.targets(root)
    const definition = Machine.make({
      root,
      input: Schema.Struct({ request: Schema.String }),
      events: Machine.events({ Reload: { request: Schema.String }, Branch: {} }),
      branches: { reset: { root: { target: targets.root } } }
    })
    const machine = definition.handle({
      initial: {
        target: targets.root.Loading,
        data: ({ input }) => {
          expect(input).type.toBe<{ readonly request: string }>()
          return { request: input.request }
        }
      },
      on: {
        Reload: { target: targets.root, input: ({ event }) => ({ request: event.request }) },
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
          initial: { target: targets.root.Loading.Busy },
          on: {
            Reload: { target: targets.root.Loading, data: ({ event }) => ({ request: event.request }) }
          }
        }
      }
    })
    expect(Machine.planInitial(machine, { request: "a" })).type.not.toBe<never>()
    const initial = { target: targets.root.Idle }
    const states = { Loading: { initial: { target: targets.root.Loading.Busy } } }
    expect(definition.handle).type.not.toBeCallableWith({ initial, states, on: { Reload: { target: targets.root } } })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { target: targets.root, input: { request: 1 } } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { target: targets.root, input: { request: "a" }, data: {} } }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      initial,
      states,
      on: { Reload: { target: targets.root.Idle, input: { request: "a" } } }
    })
  })
})
