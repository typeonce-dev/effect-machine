import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

describe("declared state paths", () => {
  const Root = Machine.state({
    fields: { seed: Schema.Number },
    states: {
      Idle: {},
      Loading: { fields: { count: Schema.Number } },
      Checkout: {
        fields: { cart: Schema.String },
        states: { Review: {}, Pay: {}, recent: { type: "history" } }
      }
    }
  })
  const Events = Machine.events({ Go: {} })
  const definition = Machine.make({ root: Root, events: Events })
  const initial = { target: "Idle" } as const
  const states = { Checkout: { initial: { target: "Checkout.Review" } } } as const
  const handle = <const On>(on: On) => ({ root: { seed: 0 }, initial, states, on: { Go: on } })

  it("reserves the top-level root name", () => {
    const Reserved = Machine.state({ states: { root: {}, Idle: {} } })
    expect(Machine.make).type.not.toBeCallableWith({ root: Reserved, events: Events })
    const Nested = Machine.state({ states: { Slot: { states: { root: {} } } } })
    expect(Machine.make).type.toBeCallableWith({ root: Nested, events: Events })
  })

  it("accepts declared dotted paths and the root owner", () => {
    expect(definition.handle).type.toBeCallableWith(handle({ target: "Checkout.Pay" }))
    expect(definition.handle).type.toBeCallableWith(handle({ target: "Loading", data: { count: 1 } }))
    expect(definition.handle).type.toBeCallableWith(handle({ history: "Checkout.recent" }))
    expect(definition.handle).type.toBeCallableWith(handle({ update: "root", data: { seed: 1 } }))
    expect(definition.handle).type.toBeCallableWith(handle({ initialize: true }))
  })

  it("rejects undeclared paths, the root as a destination, and mismatched path kinds", () => {
    expect(definition.handle).type.not.toBeCallableWith(handle({ target: "Missing" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ target: "Review" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ target: "root" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ target: "" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ update: "", data: { seed: 1 } }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ history: "Checkout.Review" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ target: "Loading" }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ initialize: { seed: 1 } }))
    expect(definition.handle).type.not.toBeCallableWith(handle({ initialize: true, target: "Idle" }))
  })

  it("checks branch declarations against the root passed to make", () => {
    expect(Machine.make).type.toBeCallableWith({
      root: Root,
      events: Events,
      branches: { go: { idle: { target: "Idle" }, reset: { initialize: true }, owner: { update: "Checkout" } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: Root,
      events: Events,
      branches: { go: { missing: { target: "Missing" } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: Root,
      events: Events,
      branches: { go: { root: { target: "root" } } }
    })
    expect(Machine.make).type.not.toBeCallableWith({
      root: Root,
      events: Events,
      branches: { go: { root: { initialize: true, target: "Idle" } } }
    })
  })
})
