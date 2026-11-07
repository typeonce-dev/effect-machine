import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
import { describe, expect, it } from "tstyche"

const Root = Machine.state({
  fields: { count: Schema.Number },
  states: {
    Editing: { fields: { complete: Schema.Boolean } },
    Checkout: {
      fields: { total: Schema.Number },
      states: {
        Charging: { fields: { amount: Schema.Number } },
        Route: { type: "choice" },
        Paid: {}
      }
    },
    Archived: {}
  }
})
const Events = Machine.events({ Bump: { by: Schema.Number }, Pay: { amount: Schema.Number } })
const Emits = Machine.emittedEvents({ Cancelled: {} })
const definition = Machine.make({ root: Root, events: Events, emittedEvents: Emits })
const handleEditing = { root: { count: 0 }, initial: { target: "Editing", data: { complete: false } } } as const
declare const widened: "Archived" | "Editing"

describe("transition declarations", () => {
  it("types every plain transition and every select call from the local declaration", () => {
    expect(definition.handle({
      ...handleEditing,
      on: { Bump: { update: { root: ({ root, event }) => ({ count: root.count + event.by }) } } },
      states: {
        Editing: {
          on: {
            Bump: { stay: true, commands: (_, enqueue) => enqueue.emit(Emits.Cancelled()) },
            Pay: {
              branches: [
                { target: "Checkout" },
                { target: "Archived" },
                { update: "Editing" },
                { stay: true },
                { decline: true }
              ],
              resolve: ({ event, select }) => {
                expect(event.amount).type.toBe<number>()
                if (event.amount < 0) return select.decline()
                if (event.amount === 1) return select.update({ Editing: { complete: true } })
                if (event.amount === 2) return select.stay()
                return event.amount === 0
                  ? select.target("Archived")
                  : select.target("Checkout", {
                    data: { total: 0 },
                    states: { Charging: { data: { amount: event.amount } } }
                  })
              }
            }
          }
        },
        Checkout: {
          initial: { target: "Checkout.Charging", data: { amount: 1 } },
          states: {
            Charging: {
              on: {
                Bump: { reenter: true, commands: (_, enqueue) => enqueue.emit(Emits.Cancelled()) },
                Pay: {
                  target: "Checkout.Route",
                  update: { Checkout: ({ event, ancestors }) => ({ total: ancestors.Checkout.total + event.amount }) }
                }
              }
            },
            Route: { choice: { target: "Checkout.Paid" } }
          }
        }
      }
    })).type.not.toRaiseError()
  })

  it("names the branch that resolve selects without declaring it", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: {
          on: { Pay: { branches: [{ target: "Archived" }], resolve: ({ select }) => select.stay() } }
        }
      }
    })).type.toRaiseError("resolve selects undeclared { stay: true }. Add it to branches")
  })

  it("names the declared branch that resolve never selects", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: {
          on: { Pay: { branches: [{ target: "Archived" }, { stay: true }], resolve: ({ select }) => select.stay() } }
        }
      }
    })).type.toRaiseError("is never selected by resolve")
  })

  it("requires branches and resolve together", () => {
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: { resolve: ({ select }) => select.stay() } } } }
    })).type.toRaiseError("resolve needs a branches list. Add: branches: [...]")
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: { branches: [{ stay: true }] } } } }
    })).type.toRaiseError("branches needs a resolve that selects one of them")
  })

  it("rejects duplicate entries", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: { on: { Pay: { branches: [{ stay: true }, { stay: true }], resolve: ({ select }) => select.stay() } } }
      }
    })).type.toRaiseError("Declared branch { stay: true } appears more than once")
  })

  it("rejects a resolve result that is not a select call on every path", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: {
          on: {
            Pay: {
              branches: [{ stay: true }],
              resolve: ({ event, select }) => event.amount > 0 ? select.stay() : undefined
            }
          }
        }
      }
    })).type.toRaiseError("resolve must return a select call on every path")
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: { on: { Pay: { branches: [{ stay: true }], resolve: async ({ select }) => select.stay() } } }
      }
    })).type.toRaiseError("resolve must return a select call on every path")
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: { on: { Pay: { branches: [{ stay: true }], resolve: ({ select }) => select.stay() as any } } }
      }
    })).type.toRaiseError("resolve must return a select call, got any")
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: { on: { Pay: { branches: [{ stay: true }], resolve: ({ select }) => select.stay() as unknown } } }
      }
    })).type.toRaiseError("resolve must return a select call, got unknown")
  })

  it("rejects a widened path", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: {
          on: {
            Pay: {
              branches: [{ target: "Archived" }, { target: "Editing" }],
              resolve: ({ select }) => select.target(widened)
            }
          }
        }
      }
    })).type.toRaiseError(
      "",
      "select.target takes one path, got: "
    )
  })

  it("rejects guard next to branches, on invocation and completion outcomes, and in a choice", () => {
    expect(definition.handle({
      ...handleEditing,
      states: {
        Editing: {
          on: {
            Pay: { guard: () => true, branches: [{ stay: true }], resolve: ({ select }) => select.stay() }
          }
        }
      }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      states: {
        Checkout: {
          initial: { target: "Checkout.Charging", data: { amount: 1 } },
          onDone: { target: "Archived", guard: () => true }
        }
      }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      states: {
        Checkout: {
          initial: { target: "Checkout.Charging", data: { amount: 1 } },
          states: { Route: { choice: { target: "Checkout.Paid", guard: () => true } } }
        }
      }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      states: {
        Checkout: {
          initial: { target: "Checkout.Charging", data: { amount: 1 } },
          states: { Route: { choice: { stay: true } } }
        }
      }
    })).type.toRaiseError()
  })

  it("rejects two owners and an unknown owner in an update record", () => {
    expect(definition.handle({
      ...handleEditing,
      on: { Pay: { update: { root: { count: 1 }, Editing: { complete: true } } } }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      on: { Pay: { update: { Typo: { count: 1 } } } }
    })).type.toRaiseError()
  })

  it("rejects removed forms and empty declarations", () => {
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: { none: true } } } }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: {} } } }
    })).type.toRaiseError()
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: { update: "root", data: { count: 1 } } } } }
    })).type.toRaiseError()
  })

  it("rejects commands that return a value", () => {
    expect(definition.handle({
      ...handleEditing,
      states: { Editing: { on: { Pay: { target: "Archived", commands: () => Promise.resolve(1) } } } }
    })).type.toRaiseError("commands must not return a value. Enqueue work with its second argument")
  })
})
