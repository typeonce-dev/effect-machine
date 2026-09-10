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
    const targets = Machine.targets(root)
    Machine.make({
      root,
      events: Machine.events({ Open: {} }),
      branches: {
        open: { checkout: { target: targets.root.Checkout }, work: { target: targets.root.Work } }
      }
    }).handle({
      initial: { target: targets.root.Idle },
      states: {
        Idle: {
          on: {
            Open: {
              branches: "open",
              resolve: ({ select }) => {
                expect(select.checkout).type.not.toBeCallableWith()
                expect(select.checkout).type.not.toBeCallableWith({ data: { cartId: 1 } })
                expect(select.checkout).type.not.toBeCallableWith({ data: () => ({ cartId: "a" }) })
                expect(select.checkout).type.not.toBeCallableWith({ data: { cartId: "a" }, states: {} })
                expect(select.checkout).type.not.toBeCallableWith({ data: { cartId: "a" }, states: { Missing: {} } })
                expect(select.checkout).type.not.toBeCallableWith({ data: { cartId: "a" }, states: { Review: {} } })
                expect(select.checkout).type.not.toBeCallableWith({
                  data: { cartId: "a" },
                  states: { Review: { data: { total: "wrong" } } }
                })
                const two = {
                  data: { cartId: "a" },
                  states: { Review: { data: { total: 1 } }, Form: { data: { email: "a" } } }
                }
                expect(select.checkout).type.not.toBeCallableWith(two)
                expect(select.checkout).type.toBeCallableWith({ data: { cartId: "a" } })
                expect(select.checkout).type.toBeCallableWith({
                  data: { cartId: "a" },
                  states: { Review: { data: { total: 1 } } }
                })
                expect(select.checkout).type.not.toBeCallableWith({ decoded: true, data: { cartId: "a" } })
                expect(select.checkout).type.toBeCallableWith({
                  decoded: true,
                  data: { _tag: "Checkout", cartId: "a" },
                  states: { Review: { data: { total: 1 } } }
                })
                expect(select.work).type.not.toBeCallableWith({ data: {} })
                expect(select.work).type.not.toBeCallableWith({ states: {} })
                expect(select.work).type.not.toBeCallableWith({ states: { Left: { data: { count: 1 } } } })
                expect(select.work).type.toBeCallableWith({ states: { Left: { data: { count: 1 } }, Right: {} } })
                return select.checkout({ data: { cartId: "a" }, states: { Review: { data: { total: 1 } } } })
              }
            }
          }
        },
        Checkout: {
          initial: {
            target: targets.root.Checkout.Review,
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
