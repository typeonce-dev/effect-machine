import { Schema } from "effect"
import { describe, expect, test } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", { count: Schema.Number }) {}
class Saved extends Schema.TaggedClass<Saved>("Saved")("Saved", { text: Schema.String }) {}
const root1 = Machine.state({
  schema: Root,
  initial: "Idle",
  states: {
    Idle: {},
    Saved: { schema: Saved },
    Nested: {
      fields: { label: Schema.String },
      initial: "Child",
      states: { Child: { fields: { required: Schema.String } } }
    }
  }
})

const targets1 = Machine.targets(root1)
const definition = Machine.make({
  branches: { saved: { ready: { target: targets1.root.Saved } } },
  root: root1,
  events: Machine.events({ Save: { text: Schema.String } }),
  initial: (root) => {
    expect(root).type.not.toHaveProperty("guard")
    expect(root).type.not.toHaveProperty("reenter")
    return root.from(() => ({ count: 0 }))
  }
})

describe("transition construction", () => {
  test("infers both values and preserves explicit construction requirements", () => {
    definition.handle({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              reenter: true,
              guard: ({ root, event }) => {
                expect(root).type.toBe<Root>()
                expect(event.text).type.toBe<string>()
                return event.text.length > 0
              },
              from: ({ root, event }) => ({ target: { text: event.text }, update: { count: root.count + 1 } })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              from: () => ({ target: {}, update: { count: 1 } })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              from: () => ({ target: { text: "" }, update: {} })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: { Save: { target: targets1.root.Saved, update: targets1.root, from: () => ({ target: { text: "" } }) } }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: () => ({ target: { text: "" }, update: new Root({ count: 1 }) })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: () => ({ target: new Saved({ text: "" }), update: { count: 1 } })
            }
          }
        }
      }
    })
    definition.handle({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Saved,
              update: targets1.root,
              decoded: () => ({ target: new Saved({ text: "" }), update: new Root({ count: 1 }) })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: {
        Idle: {
          on: {
            Save: {
              target: targets1.root.Nested,
              update: targets1.root,
              from: () => ({ target: { label: "" }, update: { count: 1 } })
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: { Idle: { on: { Save: { update: targets1.root.Idle, from: () => undefined } } } }
    })
  })
  test("guards updates without allowing incomplete replacements or implicit reentry", () => {
    definition.handle({
      on: {
        Save: {
          update: targets1.root,
          guard: ({ root, event }) => root.count > event.text.length,
          decoded: ({ root }) => {
            expect(root).type.toBe<Root>()
            return root
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({ on: { Save: { update: targets1.root, from: () => ({}) } } })
    expect(definition.handle).type.not.toBeCallableWith({
      on: { Save: { update: targets1.root, reenter: true, from: () => ({ count: 1 }) } }
    })
  })
  test("reentry composes with value construction and branch resolution", () => {
    definition.handle({
      states: {
        Idle: {
          on: {
            Save: {
              branches: "saved",
              reenter: true,
              resolve: ({ event, select }) => {
                expect(event.text).type.toBe<string>()
                return select.ready.from({ text: event.text })
              }
            }
          }
        }
      }
    })
    expect(definition.handle).type.not.toBeCallableWith({
      states: { Idle: { on: { Save: { target: targets1.root.Saved, resolve: () => undefined } } } }
    })
  })
})
