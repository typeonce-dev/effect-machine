import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("object construction", () => {
  it("binds data and complete child selections to each declared branch", () => {
    const root = Machine.state({
      states: {
        Idle: {},
        Checkout: {
          fields: { cartId: Schema.String },
          states: {
            Review: { fields: { total: Schema.Number } },
            Form: { fields: { email: Schema.String } }
          }
        },
        Work: {
          type: "parallel",
          states: {
            Left: { fields: { count: Schema.Number } },
            Right: {}
          }
        }
      }
    })
    Machine.make({
      root,
      events: Machine.events({ Open: { toWork: Schema.Boolean } })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Open: {
              branches: [{ target: "Checkout" }, { target: "Work" }],
              resolve: ({ event, select }) => {
                expect(select.target).type.not.toBeCallableWith("Checkout")
                expect(select.target).type.not.toBeCallableWith("Checkout", { data: { cartId: 1 } })
                expect(select.target).type.not.toBeCallableWith("Checkout", { data: () => ({ cartId: "a" }) })
                expect(select.target).type.not.toBeCallableWith("Checkout", { data: { cartId: "a" }, states: {} })
                expect(select.target).type.not.toBeCallableWith("Checkout", {
                  data: { cartId: "a" },
                  states: { Missing: {} }
                })
                expect(select.target).type.not.toBeCallableWith("Checkout", {
                  data: { cartId: "a" },
                  states: { Review: {} }
                })
                expect(select.target).type.not.toBeCallableWith("Checkout", {
                  data: { cartId: "a" },
                  states: { Review: { data: { total: "wrong" } } }
                })
                const two = {
                  data: { cartId: "a" },
                  states: { Review: { data: { total: 1 } }, Form: { data: { email: "a" } } }
                }
                expect(select.target).type.not.toBeCallableWith("Checkout", two)
                expect(select.target).type.toBeCallableWith("Checkout", { data: { cartId: "a" } })
                expect(select.target).type.toBeCallableWith("Checkout", {
                  data: { cartId: "a" },
                  states: { Review: { data: { total: 1 } } }
                })
                expect(select.target).type.not.toBeCallableWith("Checkout", { decoded: true, data: { cartId: "a" } })
                expect(select.target).type.toBeCallableWith("Checkout", {
                  decoded: true,
                  data: { _tag: "Checkout", cartId: "a" },
                  states: { Review: { data: { total: 1 } } }
                })
                expect(select.target).type.not.toBeCallableWith("Work", { data: {} })
                expect(select.target).type.not.toBeCallableWith("Work", { states: {} })
                expect(select.target).type.not.toBeCallableWith("Work", { states: { Left: { data: { count: 1 } } } })
                expect(select.target).type.toBeCallableWith("Work", {
                  states: { Left: { data: { count: 1 } }, Right: {} }
                })
                return event.toWork
                  ? select.target("Work", { states: { Left: { data: { count: 1 } }, Right: {} } })
                  : select.target("Checkout", { data: { cartId: "a" }, states: { Review: { data: { total: 1 } } } })
              }
            }
          }
        },
        Checkout: {
          initial: {
            target: "Checkout.Review",
            data: (context) => {
              expect(context).type.not.toHaveProperty("input")
              return { total: 0 }
            }
          }
        },
        Work: { initial: { Left: { count: 0 } } }
      }
    })
  })
})
